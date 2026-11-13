import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApplicationEvent, ScenePythonStatus } from "../../contracts/application.ts";

/** 显式安装场景环境，启动应用时不探测或联网。 */
export function createScenePythonService(options: {
  dataRoot: string;
  workerPath?: string;
  pythonExecutable?: string;
  hostPythonExecutable?: string;
  wheelhouse?: string;
  publish: (event: ApplicationEvent) => void;
}) {
  const directory = join(options.dataRoot, "python", "scene");
  const executable =
    options.pythonExecutable ??
    join(directory, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  let status: ScenePythonStatus = existsSync(executable)
    ? { state: "invalid", canInstall: false }
    : existsSync(directory)
      ? { state: "invalid", error: "已有场景环境不完整，不会自动覆盖。", canInstall: false }
      : { state: "missing", canInstall: true };
  const children = new Set<ChildProcess>();
  let operation: Promise<void> | undefined;
  let checking: Promise<ScenePythonStatus> | undefined;
  let closed = false;
  function changed(next: ScenePythonStatus) {
    status = {
      ...next,
      canInstall: (next.state === "missing" || next.state === "invalid") && !existsSync(directory),
    };
    if (!closed) {
      options.publish({ type: "scene.pythonStatus", status });
      options.publish({ type: "workspace" });
    }
    return status;
  }
  function run(
    program: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      let stderr = "";
      let complete = false;
      const process = spawn(program, args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      children.add(process);
      process.stderr?.setEncoding("utf8");
      process.stderr?.on("data", (value: string) => {
        stderr = (stderr + value).slice(-1800);
      });
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        process.kill("SIGTERM");
        forceTimer = setTimeout(() => process.kill("SIGKILL"), 5_000);
        forceTimer.unref();
      }, timeoutMs);
      timer.unref();
      const finish = (code: number | null, error?: Error) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        children.delete(process);
        resolve({ code, stderr: error?.message ?? stderr });
      };
      process.once("error", (error) => finish(null, error));
      process.once("close", (code) => finish(code));
    });
  }
  function check(): Promise<ScenePythonStatus> {
    if (closed) return Promise.reject(new Error("应用正在退出。"));
    if (operation) return Promise.resolve(status);
    if (checking) return checking;
    const task = Promise.resolve().then(async () => {
      if (closed) return status;
      if (!existsSync(executable)) {
        const next: ScenePythonStatus = existsSync(directory)
          ? { state: "invalid", error: "已有场景环境不完整，不会自动覆盖。" }
          : { state: "missing" };
        return changed(next);
      }
      const result = await run(
        executable,
        [
          "-c",
          "import vtkmodules.vtkCommonCore; from OCP.STEPCAFControl import STEPCAFControl_Reader; from OCP.BRepMesh import BRepMesh_IncrementalMesh",
        ],
        15_000,
      );
      if (closed) return status;
      const next: ScenePythonStatus =
        result.code === 0
          ? { state: "ready" }
          : { state: "invalid", error: "场景 Python 环境无法加载依赖，请检查已有环境。" };
      return changed(next);
    });
    checking = task.then(
      (result) => {
        checking = undefined;
        return result;
      },
      (error) => {
        checking = undefined;
        throw error;
      },
    );
    return checking;
  }
  return {
    executable,
    current: () => status,
    check,
    install(): ScenePythonStatus {
      if (closed) throw new Error("应用正在退出。");
      if (operation) return status;
      if (checking) throw new Error("正在检查场景环境，请稍后重试。");
      if (existsSync(directory)) throw new Error("场景环境目录已存在，不会覆盖已有环境。");
      if (!options.workerPath) throw new Error("场景安装器不可用。");
      const script = join(dirname(options.workerPath), "install.py");
      if (!existsSync(script)) throw new Error("场景安装器不可用。");
      const host =
        options.hostPythonExecutable ?? (process.platform === "win32" ? "py" : "python3.12");
      const args = [
        ...(process.platform === "win32" && !options.hostPythonExecutable ? ["-3.12"] : []),
        script,
        "--data-root",
        options.dataRoot,
        ...(options.wheelhouse ? ["--wheelhouse", options.wheelhouse] : []),
      ];
      status = { state: "installing", canInstall: false };
      operation = (async () => {
        const result = await run(host, args, 30 * 60_000);
        operation = undefined;
        if (closed) return;
        if (result.code !== 0) {
          changed({
            state: "invalid",
            error: (result.stderr.trim() || "安装失败，请确认 Python 3.12 和 pip 可用。 ").slice(
              -2000,
            ),
          });
          return;
        }
        await check();
      })();
      changed(status);
      return status;
    },
    async close() {
      closed = true;
      for (const child of children) child.kill("SIGTERM");
      const pending = [operation, checking].filter((task) => task !== undefined);
      if (pending.length) {
        const timer = setTimeout(() => {
          for (const child of children) child.kill("SIGKILL");
        }, 5_000);
        timer.unref();
        await Promise.allSettled(pending);
        clearTimeout(timer);
      }
    },
  };
}
