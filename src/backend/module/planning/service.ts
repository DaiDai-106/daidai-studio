import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { Value } from "typebox/value";
import {
  maxPlanningAssetBytes,
  type PlanningScene,
  type PlanningSource,
  PlanningWorkerSceneSchema,
} from "../../../contracts/planning.ts";
import { normalizeStl } from "../../../shared/node/stl.ts";
import { planningPreviewRobot } from "../../../shared/scene/planning_preview.ts";
import { validateRobot } from "../../../shared/scene/robot.ts";
import { readProjectFile } from "../../projects/project_access.ts";
import { startPlanningWorker } from "./worker.ts";

type Worker = ReturnType<typeof startPlanningWorker>;
type SceneLoad = {
  worker?: Worker;
  done: Promise<void>;
  finish(): void;
};
type ActiveScene = ReturnType<typeof decodeScene> & { worker: Worker; reading?: Promise<void> };

async function waitFor<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  const { promise, reject } = Promise.withResolvers<never>();
  const listener = addAbortListener(signal, () => reject(signal.reason));
  try {
    return await Promise.race([work, promise]);
  } finally {
    listener[Symbol.dispose]();
  }
}

function decodeScene(value: unknown, name: string, revision: string) {
  if (!Value.Check(PlanningWorkerSceneSchema, value)) throw new Error("One Punch 场景格式无效。");
  const { assets, ...snapshot } = value;
  validateRobot(planningPreviewRobot(snapshot.robot));
  const files = new Map<string, string>();
  for (const { id, path } of assets) {
    if (files.has(id) || !isAbsolute(path)) throw new Error("One Punch 场景网格引用无效。");
    if (extname(path).toLowerCase() !== ".stl")
      throw new Error(`规划场景网格目前只支持 STL：${basename(path)}。`);
    files.set(id, path);
  }
  for (const { geometry } of [
    ...snapshot.robot.links.flatMap(({ visuals }) => visuals),
    ...snapshot.collisionGeometry,
  ]) {
    if (geometry.type === "mesh" && !files.has(geometry.asset))
      throw new Error("One Punch 场景缺少网格引用。");
  }
  const scene: PlanningScene = { ...snapshot, name, revision, status: "loaded" };
  return { scene, files };
}

async function requireSinglePackageUrdf(directory: string) {
  const urdfs: string[] = [];
  // 与 One Punch 一样，只扫描目录顶层，并按普通文件判断 URDF。
  for (const name of await readdir(directory)) {
    if (!name.toLowerCase().endsWith(".urdf")) continue;
    try {
      if ((await stat(join(directory, name))).isFile()) urdfs.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!urdfs.length) throw new Error("Package 目录顶层没有 URDF 文件。");
  if (urdfs.length > 1)
    throw new Error(`Package 目录包含多个 URDF，请明确选择主文件：${urdfs.sort().join("、")}。`);
}

export function createPlanningService(
  workerDirectory?: string,
  publishScene?: (projectId: string, scene: PlanningScene) => void,
) {
  const active = new Map<string, ActiveScene>();
  const loading = new Map<string, SceneLoad>();
  let closing = false;

  function markStale(projectId: string, current: ActiveScene) {
    if (current.scene.status === "loaded") {
      current.scene = { ...current.scene, status: "stale" };
      publishScene?.(projectId, current.scene);
    }
    return current.scene;
  }

  function forget(projectId: string) {
    const job = loading.get(projectId);
    const current = active.get(projectId);
    loading.delete(projectId);
    active.delete(projectId);
    current?.worker.close();
    job?.worker?.close();
    job?.finish();
  }

  return {
    async load(projectId: string, kind: PlanningSource, path: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (process.platform !== "linux" || !workerDirectory)
        throw new Error("当前平台未提供 One Punch 规划程序。");
      if (closing || loading.has(projectId)) throw new Error("规划场景暂时无法加载。");
      if (!isAbsolute(path)) throw new Error("请选择本地规划场景。");
      const { promise: done, resolve: finish } = Promise.withResolvers<void>();
      const job: SceneLoad = { done, finish };
      loading.set(projectId, job);
      const abort = () => job.worker?.close();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const source = await realpath(path);
        const info = await stat(source);
        if (kind === "package") {
          if (!info.isDirectory()) throw new Error("请选择 Package 目录。");
          await requireSinglePackageUrdf(source);
        } else if (!info.isFile() || extname(source).toLowerCase() !== ".urdf") {
          throw new Error("请选择 URDF 文件。");
        }
        signal?.throwIfAborted();
        if (loading.get(projectId) !== job) throw new Error("规划场景加载已取消。");
        const worker = startPlanningWorker(join(workerDirectory, "planning-worker"), () => {
          const current = active.get(projectId);
          if (current?.worker === worker) markStale(projectId, current);
        });
        job.worker = worker;
        const value = await worker.request({ method: "loadScene", kind, path: source });
        const next = decodeScene(value, basename(path), randomUUID());
        signal?.throwIfAborted();
        if (loading.get(projectId) !== job) throw new Error("规划场景加载已取消。");
        if (!worker.available) throw new Error("One Punch 规划程序已退出，请重新加载场景。");
        const previous = active.get(projectId);
        active.set(projectId, { ...next, worker });
        previous?.worker.close();
        publishScene?.(projectId, next.scene);
        return next.scene;
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        if (job.worker && active.get(projectId)?.worker !== job.worker) job.worker.close();
        if (loading.get(projectId) === job) loading.delete(projectId);
        job.finish();
      }
    },
    async get(projectId: string, signal?: AbortSignal) {
      while (!closing) {
        signal?.throwIfAborted();
        const job = loading.get(projectId);
        if (job) {
          await waitFor(job.done, signal);
          continue;
        }
        const current = active.get(projectId);
        if (!current) return null;
        if (!current.worker.available) return markStale(projectId, current);
        current.reading ??= current.worker
          .request({ method: "getScene" })
          .then((value) => {
            const next = decodeScene(value, current.scene.name, current.scene.revision);
            if (current.worker.available) {
              current.scene = next.scene;
              current.files = next.files;
            }
          })
          .finally(() => {
            delete current.reading;
          });

        // 导出期间也可能启动替换，或移除项目并关闭原进程。
        const stillCurrent = () => active.get(projectId) === current && !loading.has(projectId);
        try {
          await waitFor(current.reading, signal);
        } catch (error) {
          signal?.throwIfAborted();
          if (stillCurrent() && current.worker.available) throw error;
        }
        signal?.throwIfAborted();
        if (stillCurrent())
          return current.worker.available ? current.scene : markStale(projectId, current);
      }
      signal?.throwIfAborted();
      return null;
    },
    async readAsset(projectId: string, revision: string, asset: string) {
      const current = active.get(projectId);
      const path = current?.scene.revision === revision ? current.files.get(asset) : undefined;
      if (!path) throw new Error("此规划场景的网格不可用，请重新加载场景。");
      const source = await realpath(path);
      const bytes = await readProjectFile(
        dirname(source),
        [basename(source)],
        maxPlanningAssetBytes,
      );
      return normalizeStl(bytes).toString("base64");
    },
    forget,
    close() {
      closing = true;
      for (const id of new Set([...loading.keys(), ...active.keys()])) forget(id);
    },
  };
}
