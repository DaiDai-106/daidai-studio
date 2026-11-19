import { fileURLToPath } from "node:url";
import { app, type UtilityProcess, utilityProcess } from "electron";
import type { ApplicationEvent } from "../../contracts/application.ts";
import { BACKEND_READY } from "../../contracts/desktop.ts";
import type { DataRootIdentity } from "../../contracts/process.ts";
import { packageName } from "../../shared/app_metadata.ts";
import { connectBackend } from "./backend.ts";

interface BackendContext {
  root: string;
  rootIdentity?: DataRootIdentity;
  isQuitting(): boolean;
  setBackend(child: UtilityProcess | undefined): void;
  setClient(client: ReturnType<typeof connectBackend>): void;
  publish(event: ApplicationEvent): void;
}

// 窗口显示前等待后端准备就绪；异常退出时不能留下无法工作的托盘应用。
export async function startBackend(context: BackendContext): Promise<void> {
  const child = utilityProcess.fork(
    fileURLToPath(new URL("./backend.js", import.meta.url)),
    [context.root, context.rootIdentity?.dev ?? "", context.rootIdentity?.ino ?? ""],
    { serviceName: `${packageName}-backend` },
  );

  // 启动等待期间也要记录进程，确保用户此时退出可以关闭它。
  context.setBackend(child);
  context.setClient(connectBackend(child, context.publish));

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
      context.setBackend(undefined);
      if (!ready) {
        reject(new Error(`Application backend exited during startup (${code}).`));
      } else if (!context.isQuitting()) {
        console.error(`Application backend exited unexpectedly (${code}).`);
        app.exit(1);
      }
    });
  });
}
