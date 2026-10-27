import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  shell,
  type Tray,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import { type Method, validateRequest } from "../../shared/application.ts";
import {
  APP_INFO_CHANNEL,
  type AppInfo,
  BACKEND_READY,
  BACKEND_SHUTDOWN,
  EVENT_CHANNEL,
  PROJECT_OPEN_CHANNEL,
  QUIT_FLUSH_CHANNEL,
  QUIT_FLUSH_READY_CHANNEL,
  QUIT_FLUSH_REGISTER_CHANNEL,
  REQUEST_CHANNEL,
  THEME_CHANNEL,
} from "../../shared/desktop.ts";
import { connectBackend } from "./backend.ts";
import { configureDataPaths } from "./paths.ts";
import { installResourceProtocol } from "./resources.ts";
import { createAppTray } from "./tray.ts";
import { createVault } from "./vault.ts";
import { installZoomShortcuts } from "./zoom.ts";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "dai-resource",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | undefined;
let backend: UtilityProcess | undefined;
let tray: Tray | undefined;
let quitting = false;
let preparingQuit = false;
let flushRegistered = false;
let quitFlush: { id: string; resolve: (success: boolean) => void } | undefined;

app.setName("daidai_pi");
const paths = configureDataPaths(app);
const vault = createVault(paths.credentials);
let client: ReturnType<typeof connectBackend> | undefined;
if (process.platform === "linux") app.setDesktopName("daidai-pi.desktop");
if (process.platform === "win32") app.setAppUserModelId("local.daidai.pi");
nativeTheme.themeSource = "light";

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed() || quitting) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function windowColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: "#1b1b1b", symbolColor: "#e6e6e6" }
    : { color: "#ffffff", symbolColor: "#252628" };
}

nativeTheme.on("updated", () => {
  if (!mainWindow) return;
  const colors = windowColors();
  mainWindow.setBackgroundColor(colors.color);
  if (process.platform !== "darwin")
    mainWindow.setTitleBarOverlay({ color: "rgba(0, 0, 0, 0)", symbolColor: colors.symbolColor });
});

async function startBackend(): Promise<void> {
  const nativeDirectory =
    process.env.DAI_NATIVE_DIRECTORY ??
    (app.isPackaged
      ? join(process.resourcesPath, "mcp", "native")
      : join(
          app.getAppPath(),
          "out",
          "native",
          ...(process.platform === "win32" ? ["Release"] : []),
        ));
  const skillsRoot = app.isPackaged
    ? join(process.resourcesPath, "skills")
    : join(app.getAppPath(), "resources", "skills");
  const child = utilityProcess.fork(
    fileURLToPath(new URL("./backend.js", import.meta.url)),
    [paths.root, vault.available() ? "secure" : "temporary", nativeDirectory, skillsRoot],
    {
      serviceName: "daidai-pi-backend",
    },
  );
  backend = child;
  client = connectBackend(child, vault, (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(EVENT_CHANNEL, event);
  });

  await new Promise<void>((resolve, reject) => {
    let ready = false;
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error("Application backend startup timed out."));
    }, 10_000);

    const onReady = (message: unknown) => {
      if (message !== BACKEND_READY) return;
      child.removeListener("message", onReady);
      clearTimeout(deadline);
      ready = true;
      resolve();
    };
    child.on("message", onReady);

    child.once("exit", (code) => {
      clearTimeout(deadline);
      backend = undefined;
      if (!ready) {
        reject(new Error(`Application backend exited during startup (${code}).`));
      } else if (!quitting) {
        console.error(`Application backend exited unexpectedly (${code}).`);
        app.exit(1);
      }
    });
  });
}

async function createWindow(): Promise<void> {
  if (quitting) return;
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
    backgroundColor: windowColors().color,
    titleBarStyle: "hidden",
    // Let renderer backgrounds and modal backdrops show behind native controls.
    titleBarOverlay: {
      color: "rgba(0, 0, 0, 0)",
      symbolColor: windowColors().symbolColor,
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
  mainWindow = window;
  window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) flushRegistered = false;
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
      /* Invalid Markdown links do not open a browser. */
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => {
    // Vite reloads the current page when optimized dependencies change.
    if (event.url !== window.webContents.getURL()) event.preventDefault();
  });
  window.on("close", (event) => {
    if (!tray || quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on("closed", () => {
    mainWindow = undefined;
  });
  if (process.platform === "win32") {
    // Windows session end bypasses before-quit; respect the committed OS shutdown.
    window.on("session-end", () => app.exit(0));
  }

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && developmentUrl) {
    await window.loadURL(developmentUrl);
  } else {
    await window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
  }
  if (quitting || window.isDestroyed()) return;
  if (!tray) tray = createAppTray(showMainWindow);
  showMainWindow();
}

ipcMain.handle(APP_INFO_CHANNEL, (event): AppInfo => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("App information is only available to the main application frame.");
  }
  return {
    name: app.getName(),
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    dataRoot: paths.root,
    secureStorage: vault.available(),
  };
});

ipcMain.handle(THEME_CHANNEL, (event, theme: unknown) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Theme changes are only available to the main application frame.");
  }
  if (theme !== "light" && theme !== "dark" && theme !== "system") {
    throw new Error("Invalid application theme.");
  }
  nativeTheme.themeSource = theme;
});

function trustedFrame(event: Electron.IpcMainInvokeEvent) {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame
  )
    throw new Error("仅主应用页面可以调用此接口。");
  if (!client || quitting) throw new Error("应用后端不可用。");
  return client;
}
ipcMain.handle(REQUEST_CHANNEL, async (event, method: unknown, args: unknown) => {
  const backend = trustedFrame(event);
  validateRequest(method, args);
  if (method === "project.open") throw new Error("项目路径只能通过系统文件夹选择器授权。");
  if (method === "auth.open") {
    const { id } = args as { id: string };
    const login = await backend.request("auth.status", { id });
    const url = new URL(login.url);
    if (login.status !== "waiting" || url.protocol !== "https:" || url.username || url.password)
      throw new Error("此授权链接不可打开，请重新开始登录。");
    await shell.openExternal(url.href);
    return null;
  }
  return backend.request(method, args as import("../../shared/application.ts").Arguments<Method>);
});
ipcMain.handle(PROJECT_OPEN_CHANNEL, async (event) => {
  const backend = trustedFrame(event);
  if (!mainWindow) throw new Error("应用窗口不可用。");
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "打开项目",
    properties: ["openDirectory"],
  });
  const path = result.filePaths[0];
  if (result.canceled || !path) return null;
  return backend.request("project.open", { path });
});

ipcMain.on(QUIT_FLUSH_REGISTER_CHANNEL, (event) => {
  if (event.sender === mainWindow?.webContents && event.senderFrame === event.sender.mainFrame)
    flushRegistered = true;
});
ipcMain.on(QUIT_FLUSH_READY_CHANNEL, (event, id: unknown, success: unknown) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame)
    return;
  if (quitFlush && quitFlush.id === id && typeof success === "boolean") quitFlush.resolve(success);
});

async function flushRendererBeforeQuit(): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed() || !flushRegistered) return true;
  const window = mainWindow;
  const contents = window.webContents;
  window.setEnabled(false);
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const deadline = setTimeout(() => finish(false), 5000);
    function finish(success: boolean) {
      clearTimeout(deadline);
      contents.removeListener("destroyed", destroyed);
      quitFlush = undefined;
      if (!success && !window.isDestroyed()) window.setEnabled(true);
      resolve(success);
    }
    function destroyed() {
      finish(false);
    }
    quitFlush = { id, resolve: finish };
    contents.once("destroyed", destroyed);
    try {
      contents.send(QUIT_FLUSH_CHANNEL, id);
    } catch {
      finish(false);
    }
  });
}

app.on("before-quit", (event) => {
  const child = backend;
  if (!child) {
    quitting = true;
    return;
  }
  event.preventDefault();
  if (quitting || preparingQuit) return;
  preparingQuit = true;
  void flushRendererBeforeQuit().then((flushed) => {
    if (!flushed) {
      preparingQuit = false;
      console.error("Unable to save draft before quitting.");
      showMainWindow();
      void dialog.showMessageBox({
        type: "error",
        title: "无法退出",
        message: "草稿未能保存，请检查应用状态后重试。",
      });
      return;
    }
    quitting = true;
    if (backend !== child) {
      app.quit();
      return;
    }
    const deadline = setTimeout(() => {
      console.error("Application backend shutdown timed out; terminating the process.");
      child.kill();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(deadline);
      app.quit();
    });
    child.postMessage(BACKEND_SHUTDOWN);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  tray?.destroy();
  tray = undefined;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
  void app
    .whenReady()
    .then(async () => {
      if (process.platform === "darwin") {
        Menu.setApplicationMenu(
          Menu.buildFromTemplate([
            { role: "appMenu", label: "Dai" },
            { role: "fileMenu" },
            { role: "editMenu" },
            { role: "windowMenu" },
          ]),
        );
      }
      await startBackend();
      installResourceProtocol(
        async (importId, resourceId) => {
          if (!client || quitting) throw new Error("应用后端不可用。");
          return client.resolveResource(importId, resourceId);
        },
        process.env.ELECTRON_RENDERER_URL
          ? new URL(process.env.ELECTRON_RENDERER_URL).origin
          : "null",
      );
      await createWindow();
      app.on("activate", () => {
        if (quitting) return;
        if (mainWindow) {
          showMainWindow();
        } else {
          void createWindow().catch((error: unknown) => {
            if (quitting) return;
            console.error(error);
            app.quit();
          });
        }
      });
    })
    .catch((error: unknown) => {
      if (quitting) return;
      console.error(error);
      app.exit(1);
    });
}
