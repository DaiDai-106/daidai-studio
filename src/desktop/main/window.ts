import { fileURLToPath } from "node:url";
import { app, BrowserWindow, nativeImage, nativeTheme, shell, type Tray } from "electron";
import { createAppTray } from "./tray.ts";
import { installZoomShortcuts } from "./zoom.ts";

interface WindowContext {
  getWindow(): BrowserWindow | undefined;
  setWindow(window: BrowserWindow | undefined): void;
  getTray(): Tray | undefined;
  setTray(tray: Tray): void;
  isQuitting(): boolean;
  resetFlushRegistration(): void;
}

// 统一管理窗口、托盘和系统主题；真正退出时不再显示窗口。
export function createWindowController(context: WindowContext) {
  function show(): void {
    const window = context.getWindow();
    if (!window || window.isDestroyed() || context.isQuitting()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  function colors() {
    return nativeTheme.shouldUseDarkColors
      ? { color: "#1b1b1b", symbolColor: "#e6e6e6" }
      : { color: "#ffffff", symbolColor: "#252628" };
  }

  nativeTheme.on("updated", () => {
    const window = context.getWindow();
    if (!window) return;
    const current = colors();
    window.setBackgroundColor(current.color);
    if (process.platform !== "darwin")
      window.setTitleBarOverlay({ color: "rgba(0, 0, 0, 0)", symbolColor: current.symbolColor });
  });

  async function create(): Promise<void> {
    if (context.isQuitting()) return;

    const icon = nativeImage.createFromPath(
      fileURLToPath(new URL("../icons/256.png", import.meta.url)),
    );
    if (icon.isEmpty()) throw new Error("Application icon could not be loaded.");

    const window = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 840,
      minHeight: 600,
      show: false,
      backgroundColor: colors().color,
      titleBarStyle: "hidden",
      // 原生窗口按钮保留透明背景，让页面和弹窗背景自然延伸。
      titleBarOverlay: {
        color: "rgba(0, 0, 0, 0)",
        symbolColor: colors().symbolColor,
        height: 60,
      },
      ...(process.platform === "darwin" ? { trafficLightPosition: { x: 16, y: 22 } } : {}),
      icon,
      webPreferences: {
        preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    if (process.platform !== "darwin") window.removeMenu();
    context.setWindow(window);
    window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) context.resetFlushRegistration();
    });
    installZoomShortcuts(window.webContents);
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url);
        if (["https:", "http:"].includes(target.protocol) && !target.username && !target.password)
          void shell
            .openExternal(target.href)
            .catch(() => console.error("External link could not be opened."));
      } catch {
        // 无效链接不打开外部浏览器。
      }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event) => {
      // 开发环境允许 Vite 重载当前页面，阻止跳转到其他地址。
      if (event.url !== window.webContents.getURL()) event.preventDefault();
    });
    window.on("close", (event) => {
      if (!context.getTray() || context.isQuitting()) return;
      // 关闭窗口只隐藏到托盘；从托盘退出才结束任务。
      event.preventDefault();
      window.hide();
    });
    window.on("closed", () => {
      context.setWindow(undefined);
    });
    if (process.platform === "win32") {
      // Windows 系统关机不会经过普通退出流程。
      window.on("session-end", () => app.exit(0));
    }

    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    if (!app.isPackaged && developmentUrl) {
      await window.loadURL(developmentUrl);
    } else {
      await window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
    }
    if (context.isQuitting() || window.isDestroyed()) return;
    if (!context.getTray()) context.setTray(createAppTray(show));

    show();
  }

  return { show, create };
}
