import { randomUUID } from "node:crypto";
import { type BrowserWindow, session, WebContentsView } from "electron";
import type { PreviewAction, PreviewBounds, PreviewEvent } from "../../../contracts/web_preview.ts";
import { PREVIEW_EVENT_CHANNEL } from "../../../contracts/web_preview.ts";
import { createStaticPreview } from "./static_server.ts";
import { allowedPreviewRequest, previewDisplayUrl, previewUrl } from "./urls.ts";

type Preview = {
  projectId: string;
  tabId: string;
  view: WebContentsView;
  origin: URL;
  status: PreviewEvent["status"];
  error?: string;
  staticPath?: string;
  release?: () => void;
};

/** 不可信页面使用独立内存 session，不加载 Dai preload 或拥有 Node 能力。 */
export function createWebPreviewController(getWindow: () => BrowserWindow | undefined) {
  const previews = new Map<string, Preview>();
  const pending = new Map<string, { projectId: string }>();
  let visible: string | null = null;

  function emit(preview: Preview) {
    const window = getWindow();
    if (
      previews.get(preview.tabId) !== preview ||
      !window ||
      window.isDestroyed() ||
      preview.view.webContents.isDestroyed()
    )
      return;
    const contents = preview.view.webContents;
    const event: PreviewEvent = {
      projectId: preview.projectId,
      tabId: preview.tabId,
      status: preview.status,
      url: preview.staticPath
        ? `项目文件：${preview.staticPath}`
        : previewDisplayUrl(contents.getURL() || preview.origin.href),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      ...(preview.error ? { error: preview.error } : {}),
    };
    window.webContents.send(PREVIEW_EVENT_CHANNEL, event);
  }

  function hide() {
    if (visible) previews.get(visible)?.view.setVisible(false);
    visible = null;
  }

  function close(projectId: string, tabId: string) {
    if (pending.get(tabId)?.projectId === projectId) pending.delete(tabId);
    const preview = previews.get(tabId);
    if (!preview || preview.projectId !== projectId) return;
    if (visible === tabId) hide();
    previews.delete(tabId);
    preview.release?.();
    const window = getWindow();
    if (window && !window.isDestroyed()) window.contentView.removeChildView(preview.view);
    const isolated = preview.view.webContents.session;
    if (!preview.view.webContents.isDestroyed()) preview.view.webContents.close();
    void isolated.clearStorageData().catch(() => {});
  }

  async function open(
    projectId: string,
    tabId: string,
    input: string,
    verifyProject: () => Promise<string>,
    source: "url" | "file" = "url",
  ) {
    const parsed = source === "url" ? previewUrl(input) : null;
    const owner = previews.get(tabId) ?? pending.get(tabId);
    if (owner && owner.projectId !== projectId) throw new Error("预览标签不属于当前项目。");
    close(projectId, tabId);
    if (previews.size + pending.size >= 10) throw new Error("最多打开 10 个网页预览。");
    const opening = { projectId };
    pending.set(tabId, opening);
    try {
      const projectPath = await verifyProject();
      if (pending.get(tabId) !== opening) throw new Error("预览已关闭。");
      const staticPreview =
        source === "file" ? await createStaticPreview(projectPath, input) : null;
      const origin = parsed ?? previewUrl(staticPreview?.url ?? "");
      if (pending.get(tabId) !== opening) {
        staticPreview?.close();
        throw new Error("预览已关闭。");
      }
      const window = getWindow();
      if (!window || window.isDestroyed()) {
        staticPreview?.close();
        throw new Error("应用窗口不可用。");
      }
      const isolated = session.fromPartition(`dai-preview-${randomUUID()}`);
      try {
        // 本地页面保留回环限制；HTTPS 使用系统网络与默认的证书校验。
        if (origin.protocol === "http:")
          await isolated.setProxy({
            proxyRules: "http=127.0.0.1:9;https=127.0.0.1:9",
            proxyBypassRules: "127.0.0.1;[::1]",
          });
      } catch (error) {
        staticPreview?.close();
        throw error;
      }
      if (pending.get(tabId) !== opening) {
        staticPreview?.close();
        throw new Error("预览已关闭。");
      }
      if (window.isDestroyed()) {
        staticPreview?.close();
        throw new Error("应用窗口不可用。");
      }
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolated.setPermissionCheckHandler(() => false);
      isolated.on("will-download", (event) => event.preventDefault());
      isolated.webRequest.onBeforeRequest((details, callback) => {
        const allowed = allowedPreviewRequest(details.url, origin);
        callback({ cancel: !allowed });
      });
      let view: WebContentsView;
      try {
        view = new WebContentsView({
          webPreferences: {
            session: isolated,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        });
        view.setVisible(false);
        window.contentView.addChildView(view);
      } catch (error) {
        staticPreview?.close();
        throw error;
      }
      const preview: Preview = {
        projectId,
        tabId,
        view,
        origin,
        status: "loading",
        ...(staticPreview ? { staticPath: input, release: staticPreview.close } : {}),
      };
      previews.set(tabId, preview);
      const contents = view.webContents;
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      function blockNavigation(event: Electron.Event, url: string) {
        if (allowedPreviewRequest(url, origin, true)) return;
        event.preventDefault();
        preview.status = "error";
        preview.error = "预览已阻止不允许的地址跳转，请使用 HTTPS 网页或原本机服务。";
        emit(preview);
      }
      contents.on("will-navigate", blockNavigation);
      contents.on("will-redirect", blockNavigation);
      contents.on("did-start-loading", () => {
        preview.status = "loading";
        delete preview.error;
        emit(preview);
      });
      contents.on("did-stop-loading", () => {
        if (preview.status !== "error") preview.status = "ready";
        emit(preview);
      });
      contents.on("did-navigate", () => emit(preview));
      contents.on("did-navigate-in-page", () => emit(preview));
      contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
        if (!mainFrame || code === -3) return;
        preview.status = "error";
        preview.error = `页面加载失败（${code}）：${description}`;
        emit(preview);
      });
      contents.on("render-process-gone", () => {
        preview.status = "error";
        preview.error = "预览进程已退出，请关闭并重新打开。";
        emit(preview);
      });
      void contents.loadURL(origin.href).catch(() => {});
      emit(preview);
    } finally {
      if (pending.get(tabId) === opening) pending.delete(tabId);
    }
  }

  function show(projectId: string, tabId: string, bounds: PreviewBounds | null) {
    const preview = previews.get(tabId);
    if (!preview || preview.projectId !== projectId) return;
    if (!bounds) {
      if (visible === tabId) hide();
      return;
    }
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    const scale = window.webContents.getZoomFactor();
    const [width = 0, height = 0] = window.getContentSize();
    const x = Math.max(0, Math.round(bounds.x * scale));
    const y = Math.max(0, Math.round(bounds.y * scale));
    const right = Math.min(width, Math.round((bounds.x + bounds.width) * scale));
    const bottom = Math.min(height, Math.round((bounds.y + bounds.height) * scale));
    if (right <= x || bottom <= y) {
      if (visible === tabId) hide();
      return;
    }
    hide();
    preview.view.setBounds({ x, y, width: right - x, height: bottom - y });
    preview.view.setVisible(true);
    visible = tabId;
  }

  function control(projectId: string, tabId: string, action: PreviewAction) {
    if (action === "close") {
      close(projectId, tabId);
      return;
    }
    const preview = previews.get(tabId);
    if (!preview || preview.projectId !== projectId || preview.view.webContents.isDestroyed())
      return;
    const contents = preview.view.webContents;
    if (action === "back" && contents.navigationHistory.canGoBack())
      contents.navigationHistory.goBack();
    if (action === "forward" && contents.navigationHistory.canGoForward())
      contents.navigationHistory.goForward();
    if (action === "reload") contents.reload();
  }

  function dispose() {
    pending.clear();
    for (const preview of previews.values()) close(preview.projectId, preview.tabId);
  }

  return { open, show, control, dispose };
}
