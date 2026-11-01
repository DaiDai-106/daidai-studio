import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCallOptions, ToolDescription } from "../../core/src/runtime.ts";

export interface SceneRuntimeOptions {
  projectId: string;
  cwd: string;
  dataDir: string;
  storageRoot?: string;
  expectedRoot?: { dev: string; ino: string };
  pythonExecutable?: string;
  workerPath?: string;
  idleTimeoutMs?: number;
}

export interface SceneImportResult {
  source: { path: string; sha256: string };
  resource: { path: string; format: "glb"; byteLength: number; sha256: string };
  objects: {
    id: string;
    name: string;
    parentId: string | null;
    sourceKey: string;
    gltfNode: number;
    rigidTransform: boolean;
    baseTransform: {
      position: [number, number, number];
      rotation: [number, number, number, number];
    };
    geometryBounds?: {
      min: [number, number, number];
      max: [number, number, number];
      size: [number, number, number];
      unit: "m";
      space: "object-local";
    };
    cylinderCandidates?: {
      faceIndex: number;
      axisOrigin: [number, number, number];
      axisDirection: [number, number, number];
      radius: number;
      unit: "m";
      space: "object-local";
      evidence: "analytic-cylinder";
      kinematics: "unknown";
    }[];
    cylinderCandidatesTruncated?: boolean;
  }[];
  complete: boolean;
  warnings: string[];
}

type DistanceReference = {
  source: { path: string; sha256: string };
  sourceKey: string;
  worldTransform: { position: number[]; rotation: number[] };
};

function distanceReference(value: unknown): DistanceReference {
  if (
    !value ||
    typeof value !== "object" ||
    !("source" in value) ||
    !("sourceKey" in value) ||
    !("worldTransform" in value)
  )
    throw new Error("距离查询对象无效。");

  const source = value.source;
  const transform = value.worldTransform;
  if (
    !source ||
    typeof source !== "object" ||
    !("path" in source) ||
    !("sha256" in source) ||
    typeof source.path !== "string" ||
    !isAbsolute(source.path) ||
    source.path.length > 4096 ||
    typeof source.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.sha256) ||
    typeof value.sourceKey !== "string" ||
    !value.sourceKey.startsWith("/") ||
    value.sourceKey.length > 4096 ||
    !transform ||
    typeof transform !== "object" ||
    !("position" in transform) ||
    !("rotation" in transform) ||
    !Array.isArray(transform.position) ||
    transform.position.length !== 3 ||
    !transform.position.every(Number.isFinite) ||
    !Array.isArray(transform.rotation) ||
    transform.rotation.length !== 4 ||
    !transform.rotation.every(Number.isFinite)
  )
    throw new Error("距离查询对象来源或位姿无效。");

  return {
    source: { path: source.path, sha256: source.sha256 },
    sourceKey: value.sourceKey,
    worldTransform: { position: transform.position, rotation: transform.rotation },
  };
}

const tools: ToolDescription[] = [
  {
    name: "scene_import",
    description: "解析用户已授权的 STEP 文件并准备场景显示资源。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "用户已授权的 STEP 绝对路径。" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

// 元数据仍留在 JSONL 协议内；限制 UTF-8 字节数以控制大装配的内存。
const MAX_WORKER_RESPONSE_BYTES = 8 * 1024 * 1024;

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
};

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function abortError(): Error {
  return new DOMException("场景操作已取消。", "AbortError");
}

/** Runtime 属于项目；Python worker 惰性启动，不承担场景持久化提交。 */
export function createSceneRuntime(options: SceneRuntimeOptions) {
  const projectId = options.projectId.trim();
  if (!projectId) throw new Error("Project ID is required");

  const dataDir = resolve(options.dataDir);
  const cwd = resolve(options.cwd);
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 2_147_483_647)
    throw new Error("Scene worker idle timeout must be positive");

  const workerPath =
    options.workerPath ?? fileURLToPath(new URL("../python/worker.py", import.meta.url));
  const pending = new Map<string, Pending>();
  let child: ChildProcessWithoutNullStreams | undefined;
  let started: Promise<ChildProcessWithoutNullStreams> | undefined;
  let stopping: Promise<void> | undefined;
  let disposed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let scheduledTasks = 0;

  // worker 是单任务进程：排队保证取消当前调用不会中断同项目其他会话。
  let queue: Promise<void> = Promise.resolve();

  function rejectPending(error: Error): void {
    for (const task of pending.values()) {
      task.cleanup();
      task.reject(error);
    }
    pending.clear();
  }

  function stopWorker(error: Error): Promise<void> {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (!child) return stopping ?? Promise.resolve();

    const target = child;
    child = undefined;
    rejectPending(error);
    stopping = new Promise<void>((done) => {
      const timer = setTimeout(() => target.kill("SIGKILL"), 2_000);
      timer.unref();
      target.once("close", () => {
        clearTimeout(timer);
        done();
      });
      target.kill("SIGTERM");
    }).finally(() => {
      stopping = undefined;
    });
    return stopping;
  }

  async function ensureWorker(): Promise<ChildProcessWithoutNullStreams> {
    if (disposed) throw new Error("Scene runtime is closed");
    if (stopping) await stopping;
    if (disposed) throw new Error("Scene runtime is closed");
    if (started) return started;
    if (child) return child;

    started = (async () => {
      // 生产环境目录由受控存储层创建；不能在 worker 校验前跟随链接创建目录。
      if (!options.storageRoot) await mkdir(dataDir, { recursive: true });
      if (disposed) throw new Error("Scene runtime is closed");
      if (!options.pythonExecutable)
        throw new Error("未配置场景 Python 环境，请先运行场景依赖安装脚本。");
      const process = spawn(
        options.pythonExecutable,
        [
          "-u",
          workerPath,
          "--project-id",
          projectId,
          "--data-dir",
          dataDir,
          ...(options.storageRoot ? ["--storage-root", resolve(options.storageRoot)] : []),
          ...(options.expectedRoot
            ? ["--root-dev", options.expectedRoot.dev, "--root-ino", options.expectedRoot.ino]
            : []),
        ],
        { cwd, stdio: "pipe", windowsHide: true },
      );
      child = process;
      let buffer = "";
      let bufferedBytes = 0;
      let stderr = "";
      process.stdin.on("error", (error) => {
        if (child === process) void stopWorker(errorOf(error));
      });
      process.stderr.setEncoding("utf8");
      process.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4_000);
      });

      process.stdout.setEncoding("utf8");
      process.stdout.on("data", (chunk: string) => {
        if (child !== process) return;
        buffer += chunk;
        bufferedBytes += Buffer.byteLength(chunk, "utf8");
        if (bufferedBytes > MAX_WORKER_RESPONSE_BYTES) {
          void stopWorker(new Error("场景 worker 响应超过大小限制。"));
          return;
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        bufferedBytes = Buffer.byteLength(buffer, "utf8");
        for (const line of lines) {
          let message: {
            id?: unknown;
            ok?: unknown;
            result?: unknown;
            error?: { message?: unknown };
          };
          try {
            message = JSON.parse(line);
          } catch {
            void stopWorker(new Error("场景 worker 返回了无效消息。"));
            return;
          }
          const id = typeof message?.id === "string" ? message.id : "";
          const task = pending.get(id);
          if (!task || typeof message.ok !== "boolean") {
            void stopWorker(new Error("场景 worker 返回了未知任务或无效结果。"));
            return;
          }
          pending.delete(id);
          task.cleanup();
          if (message.ok) task.resolve(message.result);
          else
            task.reject(
              new Error(
                typeof message.error?.message === "string"
                  ? message.error.message
                  : "场景计算失败。",
              ),
            );
        }
      });

      process.once("close", (code) => {
        if (child === process) {
          child = undefined;
          rejectPending(
            new Error(`场景 worker 已退出（${code ?? "signal"}）。${stderr ? ` ${stderr}` : ""}`),
          );
        }
      });

      await new Promise<void>((done, reject) => {
        process.once("spawn", done);
        process.once("error", (error) => {
          if (child === process) child = undefined;
          reject(
            new Error(
              `无法启动场景 Python（${options.pythonExecutable}）；请安装场景依赖：${error.message}`,
            ),
          );
        });
      });

      if (disposed) {
        await stopWorker(new Error("Scene runtime is closed"));
        throw new Error("Scene runtime is closed");
      }
      return process;
    })();

    try {
      return await started;
    } finally {
      started = undefined;
    }
  }

  async function call(
    name: string,
    input: unknown,
    callOptions: ToolCallOptions = {},
  ): Promise<unknown> {
    if (disposed) throw new Error("Scene runtime is closed");
    let params: { path: string } | { first: DistanceReference; second: DistanceReference };
    if (name === "scene_import") {
      if (
        !input ||
        typeof input !== "object" ||
        !("path" in input) ||
        typeof input.path !== "string" ||
        !isAbsolute(input.path)
      )
        throw new Error("请选择已授权的 STEP 绝对路径。");
      params = { path: input.path };
    } else if (name === "scene_measure_distance") {
      if (!input || typeof input !== "object" || !("first" in input) || !("second" in input))
        throw new Error("距离查询对象无效。");
      params = { first: distanceReference(input.first), second: distanceReference(input.second) };
    } else {
      throw new Error(`Unknown scene tool: ${name}`);
    }

    callOptions.signal?.throwIfAborted();
    scheduledTasks++;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;

    const task = queue.then(async () => {
      if (disposed) throw new Error("Scene runtime is closed");
      callOptions.signal?.throwIfAborted();
      const process = await ensureWorker();
      callOptions.signal?.throwIfAborted();
      const id = randomUUID();
      return new Promise<unknown>((resolveTask, reject) => {
        const abort = () => {
          void stopWorker(abortError());
        };
        const cleanup = () => callOptions.signal?.removeEventListener("abort", abort);
        pending.set(id, { resolve: resolveTask, reject, cleanup });
        callOptions.signal?.addEventListener("abort", abort, { once: true });
        if (callOptions.signal?.aborted) {
          abort();
          return;
        }
        process.stdin.write(`${JSON.stringify({ id, method: name, params })}\n`, (error) => {
          if (error && child === process) void stopWorker(errorOf(error));
        });
      });
    });

    const completed = () => {
      scheduledTasks--;
      if (!disposed && scheduledTasks === 0 && child) {
        idleTimer = setTimeout(() => {
          idleTimer = undefined;
          if (!disposed && scheduledTasks === 0) void stopWorker(new Error("Scene worker idle"));
        }, idleTimeoutMs);
        idleTimer.unref();
      }
    };

    queue = task.then(completed, completed);
    const signal = callOptions.signal;
    if (!signal) return task;
    return new Promise<unknown>((resolveTask, reject) => {
      const abort = () => reject(signal.reason ?? abortError());
      signal.addEventListener("abort", abort, { once: true });
      task.then(
        (result) => {
          signal.removeEventListener("abort", abort);
          resolveTask(result);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
      if (signal.aborted) abort();
    });
  }

  async function dispose(): Promise<void> {
    disposed = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (started) await started.catch(() => {});
    await stopWorker(new Error("Scene runtime is closed"));
    await queue;
  }

  return { projectId, listTools: () => tools, call, dispose };
}
