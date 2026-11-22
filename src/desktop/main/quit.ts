import { app, type BrowserWindow, dialog, ipcMain, type Tray, type UtilityProcess } from "electron";
import {
  BACKEND_SHUTDOWN,
  QUIT_FLUSH_CHANNEL,
  QUIT_FLUSH_READY_CHANNEL,
  QUIT_FLUSH_REGISTER_CHANNEL,
} from "../../contracts/desktop.ts";
import { isTrustedFrame } from "./ipc.ts";

interface QuitContext {
  getWindow(): BrowserWindow | undefined;
  getBackend(): UtilityProcess | undefined;
  isQuitting(): boolean;
  setQuitting(value: boolean): void;
  getTray(): Tray | undefined;
  setTray(value: Tray | undefined): void;
  showWindow(): void;
}

// 协调前端草稿与后端资源的有序关闭；关闭窗口到托盘不触发此流程。
export function registerQuitLifecycle(context: QuitContext) {
  let preparingQuit = false;
  let flushRegistered = false;
  let quitFlush: { id: string; resolve: (success: boolean) => void } | undefined;

  ipcMain.on(QUIT_FLUSH_REGISTER_CHANNEL, (event) => {
    if (isTrustedFrame(event, context.getWindow())) flushRegistered = true;
  });

  ipcMain.on(QUIT_FLUSH_READY_CHANNEL, (event, id: unknown, success: unknown) => {
    if (!isTrustedFrame(event, context.getWindow())) return;
    if (quitFlush && quitFlush.id === id && typeof success === "boolean")
      quitFlush.resolve(success);
  });

  async function flushRendererBeforeQuit(): Promise<boolean> {
    const window = context.getWindow();
    if (!window || window.isDestroyed() || !flushRegistered) return true;
    const targetWindow = window;
    const contents = targetWindow.webContents;
    if (contents.isCrashed()) return true;
    targetWindow.setEnabled(false);
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const deadline = setTimeout(() => finish(false), 5000);

      function finish(success: boolean) {
        clearTimeout(deadline);
        contents.removeListener("destroyed", destroyed);
        contents.removeListener("render-process-gone", rendererGone);
        quitFlush = undefined;
        if (!success && !targetWindow.isDestroyed()) targetWindow.setEnabled(true);
        resolve(success);
      }

      function destroyed() {
        finish(false);
      }

      function rendererGone() {
        finish(true);
      }

      quitFlush = { id, resolve: finish };
      contents.once("destroyed", destroyed);
      contents.once("render-process-gone", rendererGone);
      try {
        contents.send(QUIT_FLUSH_CHANNEL, id);
      } catch {
        finish(contents.isCrashed());
      }
    });
  }

  app.on("before-quit", (event) => {
    const child = context.getBackend();
    if (!child) {
      context.setQuitting(true);
      return;
    }
    event.preventDefault();
    if (context.isQuitting() || preparingQuit) return;
    preparingQuit = true;
    void flushRendererBeforeQuit().then((flushed) => {
      if (!flushed) {
        preparingQuit = false;
        console.error("Unable to save draft before quitting.");
        context.showWindow();
        void dialog.showMessageBox({
          type: "error",
          title: "无法退出",
          message: "草稿未能保存，请检查应用状态后重试。",
        });
        return;
      }
      context.setQuitting(true);
      // 草稿保存期间后端可能已退出；只关闭仍属于本次退出的进程。
      if (context.getBackend() !== child) {
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
    context.getTray()?.destroy();
    context.setTray(undefined);
  });

  return {
    // 页面重新导航后需重新注册，避免向旧页面等待草稿确认。
    resetFlushRegistration() {
      flushRegistered = false;
    },
  };
}
