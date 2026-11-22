import { statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import {
  app,
  type BrowserWindow,
  Menu,
  nativeTheme,
  type Tray,
  type UtilityProcess,
} from "electron";
import { EVENT_CHANNEL } from "../../contracts/desktop.ts";
import { desktopName, productName } from "../../shared/app_metadata.ts";
import type { connectBackend } from "./backend.ts";
import { startBackend } from "./backend_process.ts";
import { createWebPreviewController } from "./browser/controller.ts";
import { registerWebPreviewIpc } from "./browser/ipc.ts";
import { registerDesktopIpc } from "./ipc.ts";
import { configureDataPaths } from "./paths.ts";
import { registerQuitLifecycle } from "./quit.ts";
import { createWindowController } from "./window.ts";

let mainWindow: BrowserWindow | undefined;
let backend: UtilityProcess | undefined;
let tray: Tray | undefined;
let client: ReturnType<typeof connectBackend> | undefined;
let quitting = false;

app.setName(productName);
const paths = configureDataPaths(app);

if (process.platform === "linux") app.setDesktopName(desktopName);
if (process.platform === "win32") app.setAppUserModelId("local.dai-studio");
nativeTheme.themeSource = "light";

const preview = createWebPreviewController(() => mainWindow);
registerWebPreviewIpc({
  getWindow: () => mainWindow,
  getClient: () => client,
  isQuitting: () => quitting,
  preview,
});

registerDesktopIpc({
  getWindow: () => mainWindow,
  getClient: () => client,
  isQuitting: () => quitting,
  dataRoot: paths.root,
  setTheme: (theme, palette) => windows.setTheme(theme, palette),
});

const quit = registerQuitLifecycle({
  getWindow: () => mainWindow,
  getBackend: () => backend,
  isQuitting: () => quitting,
  setQuitting: (value) => {
    quitting = value;
  },
  getTray: () => tray,
  setTray: (value) => {
    tray = value;
  },
  showWindow: () => windows.show(),
});

const windows = createWindowController({
  getWindow: () => mainWindow,
  setWindow: (window) => {
    mainWindow = window;
    if (window) {
      window.webContents.on("render-process-gone", (_event, { reason, exitCode }) => {
        if (reason === "clean-exit") return;
        const message = `${new Date().toISOString()} renderer exited: ${reason} (${exitCode})\n`;
        console.error(message.trim());
        void appendFile(join(paths.root, "logs", "crashes.log"), message, { mode: 0o600 }).catch(
          (error) => console.error("Unable to save renderer exit diagnostics.", error),
        );
      });
      window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) preview.dispose();
      });
      window.once("closed", () => preview.dispose());
    }
  },
  getTray: () => tray,
  setTray: (value) => {
    tray = value;
  },
  isQuitting: () => quitting,
  resetFlushRegistration: quit.resetFlushRegistration,
});

// 单实例启动依次完成后端和窗口的初始化。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", windows.show);
  void app
    .whenReady()
    .then(async () => {
      if (paths.rootIdentity) {
        const info = statSync(paths.root, { bigint: true });
        if (
          info.dev.toString() !== paths.rootIdentity.dev ||
          info.ino.toString() !== paths.rootIdentity.ino
        ) {
          paths.close();
          throw new Error("启动时应用数据根目录发生变化，请重试。");
        }
      }

      app.once("will-quit", () => paths.close());
      if (process.platform === "darwin") {
        Menu.setApplicationMenu(
          Menu.buildFromTemplate([
            { role: "appMenu", label: productName },
            { role: "fileMenu" },
            { role: "editMenu" },
            { role: "windowMenu" },
          ]),
        );
      }

      await startBackend({
        root: paths.configuredRoot,
        ...(paths.rootIdentity ? { rootIdentity: paths.rootIdentity } : {}),
        isQuitting: () => quitting,
        setBackend: (value) => {
          backend = value;
        },
        setClient: (value) => {
          client = value;
        },
        publish: (event) => {
          if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send(EVENT_CHANNEL, event);
        },
      });

      await windows.create();

      app.on("activate", () => {
        if (quitting) return;
        if (mainWindow) {
          windows.show();
        } else {
          void windows.create().catch((error: unknown) => {
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
