import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
import {
  PREVIEW_CONTROL_CHANNEL,
  PREVIEW_OPEN_CHANNEL,
  PREVIEW_OPEN_FILE_CHANNEL,
  PREVIEW_SHOW_CHANNEL,
  type PreviewBounds,
} from "../../../contracts/web_preview.ts";
import type { connectBackend } from "../backend.ts";
import { isTrustedFrame } from "../ipc.ts";
import type { createWebPreviewController } from "./controller.ts";

type Context = {
  getWindow: () => BrowserWindow | undefined;
  getClient: () => ReturnType<typeof connectBackend> | undefined;
  isQuitting: () => boolean;
  preview: ReturnType<typeof createWebPreviewController>;
};

function input(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("预览参数无效。");
  return value as Record<string, unknown>;
}

function identity(value: Record<string, unknown>) {
  if (
    typeof value.projectId !== "string" ||
    value.projectId.length > 200 ||
    !value.projectId ||
    typeof value.tabId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(value.tabId)
  )
    throw new Error("预览身份无效。");
  return { projectId: value.projectId, tabId: value.tabId };
}

export function registerWebPreviewIpc(context: Context) {
  function trustedFrame(event: IpcMainInvokeEvent) {
    if (!isTrustedFrame(event, context.getWindow())) throw new Error("仅主应用页面可以操作预览。");
  }
  function trusted(event: IpcMainInvokeEvent) {
    trustedFrame(event);
    const backend = context.getClient();
    if (!backend || context.isQuitting()) throw new Error("应用后端不可用。");
    return backend;
  }
  async function open(event: IpcMainInvokeEvent, value: unknown, source: "url" | "file") {
    const backend = trusted(event);
    const args = input(value);
    const { projectId, tabId } = identity(args);
    const target = source === "url" ? args.url : args.path;
    if (typeof target !== "string" || target.length > 4096) throw new Error("预览地址无效。");
    await context.preview.open(
      projectId,
      tabId,
      target,
      async () => {
        const project = await backend.request("project.refresh", { id: projectId });
        if (project.mode !== "coding") throw new Error("只能在 Coding 项目打开网页预览。");
        return project.path;
      },
      source,
    );
  }
  ipcMain.handle(PREVIEW_OPEN_CHANNEL, (event, value: unknown) => open(event, value, "url"));
  ipcMain.handle(PREVIEW_OPEN_FILE_CHANNEL, (event, value: unknown) => open(event, value, "file"));
  ipcMain.handle(PREVIEW_SHOW_CHANNEL, (event, value: unknown) => {
    trustedFrame(event);
    const args = input(value);
    const { projectId, tabId } = identity(args);
    let bounds: PreviewBounds | null = null;
    if (args.bounds !== null) {
      const data = input(args.bounds);
      if (
        ![data.x, data.y, data.width, data.height].every(
          (item) => typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= 100_000,
        ) ||
        typeof data.width !== "number" ||
        typeof data.height !== "number" ||
        data.width < 0 ||
        data.height < 0
      )
        throw new Error("预览区域无效。");
      bounds = data as PreviewBounds;
    }
    context.preview.show(projectId, tabId, bounds);
  });
  ipcMain.handle(PREVIEW_CONTROL_CHANNEL, (event, value: unknown) => {
    trustedFrame(event);
    const args = input(value);
    const { projectId, tabId } = identity(args);
    if (
      args.action !== "back" &&
      args.action !== "forward" &&
      args.action !== "reload" &&
      args.action !== "close"
    )
      throw new Error("预览操作无效。");
    context.preview.control(projectId, tabId, args.action);
  });
}
