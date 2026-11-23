import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { Value } from "typebox/value";
import type { ApplicationEvent } from "../../contracts/application.ts";
import {
  maxSceneAssetBytes,
  maxUrdfBytes,
  SceneAssetSchema,
  type SceneDocument,
  type SceneOperation,
  type SceneRobot,
  type SceneSnapshot,
  type StepAttachment,
  StepAttachmentIdSchema,
} from "../../contracts/scene.ts";
import { writeAtomic, writeJson } from "../../shared/node/write_json.ts";
import { resolveSceneRobot } from "../../shared/scene/geometry.ts";
import { isStepFile } from "../../shared/scene/step_attachment.ts";
import {
  projectPathParts,
  readProjectFile,
  withProjectDirectory,
} from "../projects/project_access.ts";
import type { openProjectStore } from "../projects/store.ts";
import { editScene, validateScene } from "./document.ts";
import { loadStepAssembly, readStepSource } from "./step_import.ts";
import { createMeshBatch } from "./stl.ts";
import { parseUrdf, writeUrdf } from "./urdf.ts";

const documentLimit = 8 * maxUrdfBytes;
const undoLimit = 20;
type SceneContents = Omit<SceneDocument, "schemaVersion" | "revision"> & {
  assets?: ReadonlyMap<string, Buffer>;
};
type SceneChange = "import" | "source" | "structure" | "edit";
type UndoEntry = { document: SceneDocument; change: SceneChange };
const defaultDocument = (): SceneDocument => ({
  schemaVersion: 1,
  revision: 0,
  robot: null,
  warnings: [],
});

function* meshGeometries(robot: SceneRobot | null | undefined) {
  for (const { visuals } of robot?.links ?? []) {
    for (const { geometry } of visuals) {
      if (geometry.type === "mesh") yield geometry;
    }
  }
}

function meshParts(reference: string) {
  const parts = reference
    .replace(/^package:\/\//, "")
    .split("/")
    .filter((part) => part !== ".");
  if (
    parts.length > 24 ||
    !parts.every(
      (part) => part && part !== ".." && !/[\p{Cc}\\:<>|"*?]/u.test(part) && !/[. ]$/.test(part),
    )
  )
    throw new Error("网格必须位于 URDF 所在目录内。");
  if (extname(parts.at(-1) ?? "").toLowerCase() !== ".stl")
    throw new Error("场景首版仅支持 STL 网格。");
  return projectPathParts(parts.join("/"));
}

async function loadUrdf(path: string) {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== ".urdf")
    throw new Error("请选择 .urdf 文件。");
  const root = await realpath(dirname(path));
  const bytes = await readProjectFile(root, [basename(path)], maxUrdfBytes);
  const imported = parseUrdf(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const batch = createMeshBatch();
  const resolved = new Map<string, string>();
  for (const geometry of meshGeometries(imported.robot)) {
    const reference = geometry.asset;
    let id = resolved.get(reference);
    if (!id) {
      id = batch.add(await readProjectFile(root, meshParts(reference), maxSceneAssetBytes));
      resolved.set(reference, id);
    }
    geometry.asset = id;
  }
  return { ...imported, assets: batch.assets };
}

export function createSceneService({
  dataRoot,
  store,
  publish,
  stepWorkerDirectory,
}: {
  dataRoot: string;
  store: ReturnType<typeof openProjectStore>;
  publish: (event: ApplicationEvent) => void;
  stepWorkerDirectory?: string;
}) {
  const writes = new Map<string, Promise<void>>();
  const undo = new Map<string, UndoEntry[]>();
  const sourceRevisions = new Map<string, number>();
  const assetIndexes = new Map<string, Promise<Set<string>>>();
  let stepJob:
    | { projectId: string; controller: AbortController; result: Promise<SceneSnapshot> }
    | undefined;
  let closing = false;

  function requireScene(projectId: string) {
    if (store.getProject(projectId)?.mode !== "scene") throw new Error("场景项目不存在。");
  }

  function parts(projectId: string) {
    if (!/^[0-9a-f-]{36}$/.test(projectId)) throw new Error("场景项目标识无效。");
    return ["projects", projectId, "scene"];
  }

  async function makeDirectories(path: string[]) {
    const parents: string[] = [];
    for (const name of path) {
      await withProjectDirectory(dataRoot, parents, async (directory) => {
        try {
          await mkdir(join(directory, name), { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      });
      parents.push(name);
    }
  }

  function snapshot(projectId: string, document: SceneDocument): SceneSnapshot {
    return {
      document,
      canUndo: document.revision > 0 && Boolean(undo.get(projectId)?.length),
      sourceRevision: sourceRevisions.get(projectId) ?? 0,
    };
  }

  async function get(projectId: string) {
    requireScene(projectId);
    const documentPath = [...parts(projectId), "document.json"];
    let document: unknown;
    try {
      const bytes = await readProjectFile(dataRoot, documentPath, documentLimit);
      document = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return snapshot(projectId, defaultDocument());
    }
    validateScene(document);
    return snapshot(projectId, document);
  }

  function enqueue<T>(projectId: string, run: () => Promise<T>) {
    const next = (writes.get(projectId) ?? Promise.resolve()).then(run);
    const tail = next.then(
      () => {},
      () => {},
    );
    writes.set(projectId, tail);
    void tail.then(() => {
      if (writes.get(projectId) === tail) writes.delete(projectId);
    });
    return next;
  }

  async function current(projectId: string, expectedRevision: number) {
    const snapshot = await get(projectId);
    if (snapshot.document.revision !== expectedRevision)
      throw new Error("场景已更新，请查看最新状态后重试。");
    return snapshot;
  }

  async function persist(
    projectId: string,
    previous: SceneDocument,
    next: SceneContents,
    change: SceneChange | "undo",
    signal?: AbortSignal,
  ) {
    const { assets, ...contents } = next;
    const document: SceneDocument = {
      ...contents,
      schemaVersion: 1,
      revision: previous.revision + 1,
    };
    validateScene(document);
    if ((change === "import" || change === "structure") && document.robot)
      writeUrdf(resolveSceneRobot(document) ?? document.robot, document.warnings);
    const folder = parts(projectId);
    if (assets?.size) {
      const meshFolder = [...folder, "meshes"];
      await makeDirectories(meshFolder);
      await withProjectDirectory(dataRoot, meshFolder, async (directory) => {
        for (const [id, data] of assets) {
          try {
            const existing = await readProjectFile(
              dataRoot,
              [...meshFolder, id],
              maxSceneAssetBytes,
              signal,
            );
            if (existing.equals(data)) continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await writeAtomic(join(directory, id), data, signal);
        }
      });
    } else if (previous.revision === 0) await makeDirectories(folder);
    requireScene(projectId);
    signal?.throwIfAborted();
    await withProjectDirectory(dataRoot, folder, (directory) =>
      writeJson(join(directory, "document.json"), document, signal),
    );
    assetIndexes.delete(projectId);
    const history = undo.get(projectId) ?? [];
    const applied = change === "undo" ? history.pop()?.change : change;
    if (change !== "undo") {
      history.push({ document: previous, change });
      if (history.length > undoLimit) history.shift();
    }
    if (history.length) undo.set(projectId, history);
    else undo.delete(projectId);
    if (applied === "import" || applied === "source")
      sourceRevisions.set(projectId, document.revision);
    const updated = snapshot(projectId, document);
    publish({
      type: "scene.document",
      projectId,
      snapshot: updated,
      ...(applied === "import" ? { replaced: true } : {}),
    });
    return updated;
  }

  async function readAsset(projectId: string, asset: string) {
    if (!Value.Check(SceneAssetSchema, asset)) throw new Error("网格标识无效。");
    requireScene(projectId);
    let index = assetIndexes.get(projectId);
    if (!index) {
      // 同一次装配加载的并发网格请求共用已校验文档的资源索引。
      const loading = get(projectId).then(({ document }) => {
        const assets = new Set<string>();
        for (const robot of [document.robot, document.sourceRobot])
          for (const { asset } of meshGeometries(robot)) assets.add(asset);
        return assets;
      });
      assetIndexes.set(projectId, loading);
      void loading.catch(() => {
        if (assetIndexes.get(projectId) === loading) assetIndexes.delete(projectId);
      });
      index = loading;
    }
    if (!(await index).has(asset)) throw new Error("网格不在当前场景中。");
    return readProjectFile(dataRoot, [...parts(projectId), "meshes", asset], maxSceneAssetBytes);
  }

  function cancelStep(projectId: string) {
    if (stepJob?.projectId === projectId) stepJob.controller.abort(new Error("STEP 导入已取消。"));
    return null;
  }

  function importStep(
    projectId: string,
    expectedRevision: number,
    path: string,
    options: { signal?: AbortSignal | undefined; sourceOnly?: boolean | undefined } = {},
  ) {
    if (closing) throw new Error("应用正在退出。");
    if (stepJob) throw new Error("正在导入另一个 STEP，请等待它完成。");
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const result = (async () => {
      await enqueue(projectId, async () => {
        const { document } = await current(projectId, expectedRevision);
        if (options.sourceOnly && !document.robot) throw new Error("请先导入场景。");
        if (options.sourceOnly && document.robot?.links.some((link) => link.sourceParts?.length))
          throw new Error("当前原始模型已有零件绑定，请先解除绑定再替换原始模型。");
      });
      const next = await loadStepAssembly(path, signal, stepWorkerDirectory);
      return enqueue(projectId, async () => {
        signal.throwIfAborted();
        const { document } = await current(projectId, expectedRevision);
        const contents = options.sourceOnly
          ? {
              ...document,
              transparencies:
                document.transparencies?.filter((setting) => setting.entity === "link") ?? [],
            }
          : {
              robot: {
                ...next.robot,
                links: [{ id: next.robot.rootLinkId, name: "base_link", visuals: [] }],
                joints: [],
              },
              warnings: [],
            };
        return persist(
          projectId,
          document,
          {
            ...contents,
            sourceRobot: next.robot,
            sourceWarnings: next.warnings,
            assets: next.assets,
          },
          options.sourceOnly ? "source" : "import",
          signal,
        );
      });
    })();
    stepJob = { projectId, controller, result };
    const release = () => {
      stepJob = undefined;
    };
    void result.then(release, release);
    return result;
  }

  function attachmentRoot(projectId: string) {
    return [...parts(projectId), "attachments"];
  }

  async function removeStepAttachment(projectId: string, id: string) {
    if (!Value.Check(StepAttachmentIdSchema, id)) throw new Error("STEP 附件标识无效。");
    await withProjectDirectory(dataRoot, attachmentRoot(projectId), (directory) =>
      rm(join(directory, id), { recursive: true, force: true, maxRetries: 3 }),
    );
  }

  return {
    get: (projectId: string) => enqueue(projectId, () => get(projectId)),
    readAsset,
    apply(
      projectId: string,
      expectedRevision: number,
      operation: SceneOperation,
      signal?: AbortSignal,
    ) {
      return enqueue(projectId, async () => {
        signal?.throwIfAborted();
        const snapshot = await current(projectId, expectedRevision);
        signal?.throwIfAborted();
        const previous = snapshot.document;
        if (operation.op === "undo") {
          const entry = undo.get(projectId)?.at(-1);
          if (!entry) throw new Error("没有可撤销的操作。");
          return persist(projectId, previous, entry.document, "undo", signal);
        }
        const next = editScene(previous, operation);
        if (next === previous) return snapshot;
        return persist(
          projectId,
          previous,
          next,
          operation.op === "setJointPosition" || operation.op === "setTransparency"
            ? "edit"
            : "structure",
          signal,
        );
      });
    },
    importUrdf(projectId: string, expectedRevision: number, path: string) {
      return enqueue(projectId, async () => {
        const { document: previous } = await current(projectId, expectedRevision);
        return persist(
          projectId,
          previous,
          {
            ...previous,
            ...(await loadUrdf(path)),
            transparencies:
              previous.transparencies?.filter((setting) => setting.entity === "source") ?? [],
          },
          "import",
        );
      });
    },
    importStep,
    async saveStepAttachment(
      projectId: string,
      path: string,
      signal: AbortSignal,
    ): Promise<StepAttachment> {
      requireScene(projectId);
      const data = await readStepSource(path, signal);
      const id = randomUUID();
      const name = basename(path).replace(/\p{Cc}/gu, "_");
      const folder = [...attachmentRoot(projectId), id];
      try {
        await makeDirectories(folder);
        // 保留文件名，用于导入后的场景名称。
        await withProjectDirectory(dataRoot, folder, (directory) =>
          writeFile(join(directory, name), data, { flag: "wx", mode: 0o600, signal }),
        );
        signal.throwIfAborted();
        return { id, name };
      } catch (error) {
        await removeStepAttachment(projectId, id).catch(() => {});
        throw error;
      }
    },
    removeStepAttachment,
    async importStepAttachment(
      projectId: string,
      expectedRevision: number,
      attachmentId: string,
      signal?: AbortSignal,
    ) {
      requireScene(projectId);
      if (!Value.Check(StepAttachmentIdSchema, attachmentId))
        throw new Error("STEP 附件标识无效。");
      try {
        return await withProjectDirectory(
          dataRoot,
          [...attachmentRoot(projectId), attachmentId],
          async (directory) => {
            const files = await readdir(directory);
            const name = files[0];
            if (files.length !== 1 || !name || !isStepFile(name))
              throw new Error("STEP 附件不可用。");
            return importStep(projectId, expectedRevision, join(directory, name), { signal });
          },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error("STEP 附件不可用。");
        throw error;
      }
    },
    cancelStep,
    async close() {
      closing = true;
      const active = stepJob;
      active?.controller.abort(new Error("STEP 导入已取消。"));
      await active?.result.catch(() => {});
    },
    exportUrdf(projectId: string, directory: string, expectedRevision: number) {
      return enqueue(projectId, async () => {
        const { document } = await current(projectId, expectedRevision);
        if (!document.robot) throw new Error("请先导入 URDF。");
        if (!isAbsolute(directory)) throw new Error("请选择导出目录。");
        const robot = resolveSceneRobot(document) ?? document.robot;
        const content = writeUrdf(robot, document.warnings);
        const folder = await mkdtemp(join(await realpath(directory), "dai-urdf-"));
        try {
          const assets = new Set(Array.from(meshGeometries(robot), ({ asset }) => asset));
          const meshFolder = [...parts(projectId), "meshes"];
          if (assets.size) await mkdir(join(folder, "meshes"));
          for (const id of assets) {
            const data = await readProjectFile(dataRoot, [...meshFolder, id], maxSceneAssetBytes);
            await writeFile(join(folder, "meshes", id), data, { flag: "wx" });
          }
          const path = join(folder, "robot.urdf");
          await writeFile(path, content, { encoding: "utf8", flag: "wx" });
          return { path };
        } catch (error) {
          await rm(folder, { recursive: true, force: true });
          throw error;
        }
      });
    },
    forget(projectId: string) {
      cancelStep(projectId);
      undo.delete(projectId);
      sourceRevisions.delete(projectId);
      assetIndexes.delete(projectId);
    },
  };
}
