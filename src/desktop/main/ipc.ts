import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, type BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain, shell } from "electron";
import { Value } from "typebox/value";
import { type Arguments, type Method, validateRequest } from "../../contracts/application.ts";
import type { Theme } from "../../contracts/desktop.ts";
import {
  APP_INFO_CHANNEL,
  type AppInfo,
  PROJECT_CREATE_CHANNEL,
  PROJECT_DIRECTORY_CHANNEL,
  REQUEST_CHANNEL,
  SKILL_IMPORT_CHANNEL,
  THEME_CHANNEL,
  THEMES_CHANNEL,
} from "../../contracts/desktop.ts";
import { type WindowPalette, WindowPaletteSchema } from "../../contracts/desktop_theme.ts";
import type { connectBackend } from "./backend.ts";
import { createProjectDirectory } from "./project_directory.ts";
import { readDesktopThemes } from "./themes.ts";

type DesktopIpcContext = {
  getWindow(): BrowserWindow | undefined;
  getClient(): ReturnType<typeof connectBackend> | undefined;
  isQuitting(): boolean;
  dataRoot: string;
  setTheme(theme: Theme, palette?: WindowPalette): void;
};

// 只允许主窗口的主页面访问桌面接口；这个检查本身不依赖后端状态。
export function isTrustedFrame(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  window: BrowserWindow | undefined,
): boolean {
  return (
    !!window && event.sender === window.webContents && event.senderFrame === event.sender.mainFrame
  );
}

// 注册渲染进程可调用的桌面接口，项目路径只能通过系统选择器授权。
export function registerDesktopIpc(context: DesktopIpcContext): void {
  let selectedDirectory: { token: string; path: string; creating: boolean } | undefined;
  // 只记住所选主题的来源，用于区分清单暂时缺失和实际移除。
  let selectedTheme: { id: string; source: string } | undefined;

  async function desktopThemes(client: ReturnType<typeof connectBackend>, selectedId = "") {
    if (selectedTheme?.id !== selectedId) selectedTheme = undefined;
    const result = await readDesktopThemes(
      // 桌面加载只依赖自身安装空间，市场配置或 Agent 加载失败不影响主题。
      await client.request("package.list", { host: "desktop" }),
      selectedId,
      selectedTheme?.source,
    );
    if (result.selection !== "error") {
      const current = result.themes.find((theme) => theme.id === selectedId);
      selectedTheme = current && { id: current.id, source: current.source };
    }
    return result;
  }

  function trustedClient(event: IpcMainInvokeEvent) {
    if (!isTrustedFrame(event, context.getWindow()))
      throw new Error("仅主应用页面可以调用此接口。");

    const client = context.getClient();
    if (!client || context.isQuitting()) throw new Error("应用后端不可用。");
    return client;
  }

  ipcMain.handle(APP_INFO_CHANNEL, (event): AppInfo => {
    if (!isTrustedFrame(event, context.getWindow())) {
      throw new Error("App information is only available to the main application frame.");
    }
    return {
      name: app.getName(),
      version: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      dataRoot: context.dataRoot,
    };
  });

  ipcMain.handle(THEMES_CHANNEL, async (event, selectedId: unknown = "") => {
    const client = trustedClient(event);
    if (typeof selectedId !== "string" || selectedId.length > 300)
      throw new Error("Invalid desktop theme ID.");
    return desktopThemes(client, selectedId);
  });

  ipcMain.handle(THEME_CHANNEL, (event, theme: unknown, palette: unknown) => {
    if (!isTrustedFrame(event, context.getWindow())) {
      throw new Error("Theme changes are only available to the main application frame.");
    }
    if (theme !== "light" && theme !== "dark" && theme !== "system") {
      throw new Error("Invalid application theme.");
    }
    if (palette !== undefined && !Value.Check(WindowPaletteSchema, palette))
      throw new Error("Invalid window palette.");
    context.setTheme(theme, palette as WindowPalette | undefined);
  });

  ipcMain.handle(REQUEST_CHANNEL, async (event, method: unknown, args: unknown) => {
    const backend = trustedClient(event);
    validateRequest(method, args);
    if (method === "settings.update") {
      const { desktopTheme } = args as Arguments<"settings.update">;
      if (desktopTheme) {
        const { themes } = await desktopThemes(backend, desktopTheme);
        if (!themes.some((theme) => theme.id === desktopTheme))
          throw new Error("请选择已启用且可用的全局桌面主题。");
      }
    }

    if (method === "project.create")
      throw new Error("项目路径只能由主进程创建或通过系统文件夹选择器授权。");
    if (method === "skill.library.import")
      throw new Error("文件和技能目录只能通过系统选择器或拖拽授权。");

    if (method === "auth.open") {
      const { id } = args as { id: string };
      const login = await backend.request("auth.status", { id });
      const url = new URL(login.url);
      if (login.status !== "waiting" || url.protocol !== "https:" || url.username || url.password)
        throw new Error("此授权链接不可打开，请重新开始登录。");
      await shell.openExternal(url.href);
      return null;
    }

    return backend.request(method, args as Arguments<Method>);
  });

  ipcMain.handle(PROJECT_DIRECTORY_CHANNEL, async (event) => {
    trustedClient(event);
    const window = context.getWindow();
    if (!window) throw new Error("应用窗口不可用。");
    const result = await dialog.showOpenDialog(window, {
      title: "选择项目文件夹",
      properties: ["openDirectory"],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    selectedDirectory = { token: randomUUID(), path, creating: false };
    return { token: selectedDirectory.token, path };
  });

  ipcMain.handle(PROJECT_CREATE_CHANNEL, async (event, input: unknown) => {
    const backend = trustedClient(event);
    if (!input || typeof input !== "object") throw new Error("无效的项目配置。");
    const { name, mode, directoryToken } = input as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      (directoryToken !== undefined && typeof directoryToken !== "string") ||
      mode !== "coding"
    )
      throw new Error("无效的项目配置。");

    const projectName = name.trim();
    const defaultRoot = join(app.getPath("documents"), "Dai");
    // 令牌只代表主进程的文件选择结果，不能从前端传入任意路径。
    validateRequest("project.create", { name: projectName, mode, path: defaultRoot });
    let path: string;
    let selection: typeof selectedDirectory;
    if (directoryToken !== undefined) {
      if (!selectedDirectory || selectedDirectory.token !== directoryToken)
        throw new Error("文件夹选择已失效，请重新选择。");
      if (selectedDirectory.creating) throw new Error("该文件夹正在创建项目，请稍候。");
      selection = selectedDirectory;
      selection.creating = true;
      path = selection.path;
    } else {
      path = await createProjectDirectory(defaultRoot, projectName);
    }
    try {
      const project = await backend.request("project.create", { name: projectName, mode, path });
      if (selection && selectedDirectory === selection) selectedDirectory = undefined;
      return project;
    } finally {
      // 失败后允许重试；期间的新选择不能被旧请求清除。
      if (selection) selection.creating = false;
    }
  });

  ipcMain.handle(SKILL_IMPORT_CHANNEL, async (event) => {
    const backend = trustedClient(event);
    const window = context.getWindow();
    if (!window) throw new Error("应用窗口不可用。");
    const result = await dialog.showOpenDialog(window, {
      title: "选择技能目录",
      properties: ["openDirectory"],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    return backend.request("skill.library.import", { path });
  });
}
