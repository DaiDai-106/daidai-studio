import { statSync } from "node:fs";
import {
  app,
  type BrowserWindow,
  Menu,
  nativeTheme,
  protocol,
  type Tray,
  type UtilityProcess,
} from "electron";
import { EVENT_CHANNEL } from "../../contracts/desktop.ts";
import type { connectBackend } from "./backend.ts";
import { startBackend } from "./backendProcess.ts";
import { registerDesktopIpc } from "./ipc.ts";
import { configureDataPaths } from "./paths.ts";
import { registerQuitLifecycle } from "./quit.ts";
import { installResourceProtocol } from "./resources.ts";
import { createWindowController } from "./window.ts";

// 资源协议必须在 Electron 准备就绪之前注册。
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
let client: ReturnType<typeof connectBackend> | undefined;
let quitting = false;

app.setName("daidai_pi");
const paths = configureDataPaths(app);

if (process.platform === "linux") app.setDesktopName("daidai-pi.desktop");
if (process.platform === "win32") app.setAppUserModelId("local.daidai.pi");
nativeTheme.themeSource = "light";

registerDesktopIpc({
  getWindow: () => mainWindow,
  getClient: () => client,
  isQuitting: () => quitting,
  dataRoot: paths.root,
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
  },
  getTray: () => tray,
  setTray: (value) => {
    tray = value;
  },
  isQuitting: () => quitting,
  resetFlushRegistration: quit.resetFlushRegistration,
});

// 单实例启动依次完成后端、受控资源协议和窗口的初始化。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", windows.show);
  void app
    .whenReady()
    .then(async () => {
      const resourceReader = paths.resourceReader;
      if (resourceReader.identity) {
        const info = statSync(paths.root, { bigint: true });
        if (
          info.dev.toString() !== resourceReader.identity.dev ||
          info.ino.toString() !== resourceReader.identity.ino
        ) {
          resourceReader.close();
          throw new Error("启动时应用数据根目录发生变化，请重试。");
        }
      }

      app.once("will-quit", () => resourceReader.close());
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

      await startBackend({
        root: paths.configuredRoot,
        ...(resourceReader.identity ? { rootIdentity: resourceReader.identity } : {}),
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

      const closeResourceProtocol = installResourceProtocol(
        async (importId, resourceId) => {
          if (!client || quitting) throw new Error("应用后端不可用。");
          return client.resolveResource(importId, resourceId);
        },
        process.env.ELECTRON_RENDERER_URL
          ? new URL(process.env.ELECTRON_RENDERER_URL).origin
          : "null",
        resourceReader,
      );
      app.once("will-quit", closeResourceProtocol);
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
