import { createHash, randomUUID } from "node:crypto";
import { constants, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createRuntimeManager } from "../../../packages/core/src/runtime.ts";
import {
  createJointDraft as buildJointDraft,
  confirmJointDraft,
  type JointAxis,
  type JointCandidate,
  type JointObjectRef,
  type JointScene,
  reconcileJointCandidates,
} from "../../../packages/scene/src/joints.ts";
import { markDeletedSubtree } from "../../../packages/scene/src/objects.ts";
import { createSceneRuntime } from "../../../packages/scene/src/runtime.ts";
import {
  alignBoundsToOrigin,
  compareCylinderAxes,
  getObjectWorldTransform,
  getWorldBounds,
} from "../../../packages/scene/src/world.ts";
import type { SceneTransform, SceneView } from "../../contracts/application.ts";
import type { DataRootIdentity, ResourceLocation } from "../../contracts/process.ts";
import type { openProjectStore } from "../projects/store.ts";
import { sceneModelId as modelId } from "./scene_identity.ts";
import { ensureSceneDirectory, validateSceneResource } from "./scene_paths.ts";
import { commitSceneImport, type SceneImport } from "./scene_store.ts";

type SavedModel = SceneImport & {
  stableId?: string;
  sourceStat?: { size: number; mtimeMs: number };
};
type Document = { models: SavedModel[]; joints?: JointCandidate[] };
const pointSchema = Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);
const distanceResultSchema = Type.Object(
  {
    shapeDistanceM: Type.Number({ minimum: 0 }),
    surfaceDistanceM: Type.Null(),
    collision: Type.Literal("unknown"),
    innerSolution: Type.Boolean(),
    firstPoint: Type.Union([pointSchema, Type.Null()]),
    secondPoint: Type.Union([pointSchema, Type.Null()]),
    unit: Type.Literal("m"),
    space: Type.Literal("world-z-up"),
    method: Type.Literal("occt-brep"),
  },
  { additionalProperties: false },
);

function jointScene(document: Document, revision: number): JointScene {
  return {
    revision,
    models: document.models.map((model, index) => ({
      id: modelId(model, index),
      objects: model.objects,
    })),
  };
}

const resourceGroup = (projectId: string) =>
  createHash("sha256").update(`dai-scene:${projectId}`).digest("hex");

function sourceStatus(model: SavedModel): SceneView["models"][number]["sourceStatus"] {
  try {
    const info = statSync(model.source.path);
    if (!info.isFile()) return "missing";
    if (!model.sourceStat) return "unknown";
    return info.size === model.sourceStat.size && info.mtimeMs === model.sourceStat.mtimeMs
      ? "available"
      : "changed";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown";
  }
}

/** 每个项目惰性创建 Runtime；只在使用工具时启动 Python worker。 */
export function createSceneService(options: {
  store: ReturnType<typeof openProjectStore>;
  changed?: (view: SceneView) => void;
  dataRoot: string;
  expectedRoot?: DataRootIdentity;
  pythonExecutable?: string;
  workerPath?: string;
}) {
  const { store, dataRoot } = options;
  const imports = new Map<string, AbortController>();
  const directory = (projectId: string) => join(dataRoot, "projects", projectId, "scene");
  const manager = createRuntimeManager(async (projectId) => {
    const project = store.getProject(projectId);
    if (project?.mode !== "scene") throw new Error("场景项目不存在。");
    const dataDir = await ensureSceneDirectory(dataRoot, projectId, options.expectedRoot);
    return createSceneRuntime({
      projectId,
      cwd: project.path,
      dataDir,
      storageRoot: dataRoot,
      ...(options.expectedRoot ? { expectedRoot: options.expectedRoot } : {}),
      ...(options.pythonExecutable ? { pythonExecutable: options.pythonExecutable } : {}),
      ...(options.workerPath ? { workerPath: options.workerPath } : {}),
    });
  });

  function scene(projectId: string): SceneView {
    const project = store.getProject(projectId);
    if (project?.mode !== "scene") throw new Error("场景项目不存在。");
    const saved = store.getScene(projectId);
    const document = saved?.document as Document | undefined;

    return {
      projectId,
      revision: saved?.revision ?? 0,
      joints: document?.joints ?? [],
      models: (document?.models ?? []).map((model, index) => ({
        id: modelId(model, index),
        sourcePath: model.source.path,
        sourceHash: model.source.sha256,
        sourceStatus: sourceStatus(model),
        resource: {
          url: `dai-resource://${resourceGroup(projectId)}/${model.resource.sha256}`,
          sha256: model.resource.sha256,
          byteLength: model.resource.byteLength,
        },
        objects: model.objects,
        warnings: model.warnings,
        complete: model.complete,
      })),
    };
  }

  function committed(projectId: string): SceneView {
    const view = scene(projectId);
    options.changed?.(view);
    return view;
  }

  function setTransform(input: {
    projectId: string;
    modelId: string;
    objectId: string;
    revision: number;
    transform: SceneTransform;
  }) {
    const saved = store.getScene(input.projectId);
    if (!saved || saved.revision !== input.revision)
      throw new Error("场景已被其他会话更新，请重新加载。");

    const document = saved.document as Document;
    const index = document.models.findIndex(
      (model, position) => modelId(model, position) === input.modelId,
    );
    const model = document.models[index];
    if (!model) throw new Error("场景模型不存在。");
    const object = model.objects.find((item) => item.id === input.objectId);
    if (!object) throw new Error("场景对象不存在。");
    if (object.deleted) throw new Error("场景对象已删除。");

    const { position, rotation } = input.transform;
    if (![...position, ...rotation].every(Number.isFinite))
      throw new Error("对象变换必须是有限数字。");
    const norm = Math.hypot(...rotation);
    if (norm < 1e-12) throw new Error("旋转四元数无效。");

    const normalized: SceneTransform = {
      position,
      rotation: [rotation[0] / norm, rotation[1] / norm, rotation[2] / norm, rotation[3] / norm],
    };
    const models = [...document.models];
    models[index] = {
      ...model,
      objects: model.objects.map((object) =>
        object.id === input.objectId ? { ...object, transform: normalized } : object,
      ),
    };
    const next = { ...document, models };

    const joints = reconcileJointCandidates(
      document.joints ?? [],
      jointScene(next, input.revision + 1),
      [{ modelId: input.modelId, objectId: input.objectId }],
    );
    store.saveScene(input.projectId, input.revision, { ...next, joints });
    return committed(input.projectId);
  }

  function target(projectId: string, id: string) {
    const saved = store.getScene(projectId);
    if (!saved) throw new Error("场景为空。");
    const document = saved.document as Document;
    const model = document.models.find((item, index) => modelId(item, index) === id);
    if (!model) throw new Error("场景模型不存在。");
    return { model, revision: saved.revision };
  }

  function removeJoint(
    input: { projectId: string; candidateId: string; revision: number },
    status: "draft" | "confirmed",
  ) {
    const saved = store.getScene(input.projectId);
    if (!saved || saved.revision !== input.revision) throw new Error("场景版本已变化。");
    const document = saved.document as Document;
    const existing = document.joints ?? [];
    const matches = existing.filter((candidate) => candidate.id === input.candidateId);
    if (matches.length !== 1 || !matches[0]) throw new Error("关节候选不存在或 ID 重复。");
    if (matches[0].status !== status)
      throw new Error(
        status === "draft" ? "只能放弃草稿；已确认关节需要用户明确操作。" : "只能移除已确认关节。",
      );
    store.saveScene(input.projectId, input.revision, {
      ...document,
      joints: existing.filter((candidate) => candidate.id !== input.candidateId),
    });
    return committed(input.projectId);
  }

  return {
    get: scene,
    async import(input: {
      projectId: string;
      path: string;
      revision: number;
      operation: "replace" | "append";
    }) {
      if (scene(input.projectId).revision !== input.revision)
        throw new Error("场景已被其他会话更新，请重新加载。");
      if (imports.has(input.projectId)) throw new Error("当前项目已有场景导入正在进行。");
      const controller = new AbortController();
      imports.set(input.projectId, controller);
      try {
        const runtime = await manager.get(input.projectId);
        controller.signal.throwIfAborted();
        const result = await runtime.call(
          "scene_import",
          { path: input.path },
          { signal: controller.signal },
        );
        await commitSceneImport({
          store,
          dataDir: directory(input.projectId),
          projectId: input.projectId,
          expectedRevision: input.revision,
          approvedStepPath: input.path,
          result,
          operation: input.operation,
          dataRoot,
          ...(options.expectedRoot ? { expectedRoot: options.expectedRoot } : {}),
          signal: controller.signal,
        });
        return committed(input.projectId);
      } finally {
        if (imports.get(input.projectId) === controller) imports.delete(input.projectId);
      }
    },

    cancelImport(projectId: string) {
      const project = store.getProject(projectId);
      if (project?.mode !== "scene") throw new Error("场景项目不存在。");
      imports.get(projectId)?.abort();
    },

    isImporting(projectId: string) {
      return imports.has(projectId);
    },

    async relocateSource(input: {
      projectId: string;
      modelId: string;
      revision: number;
      path: string;
    }) {
      if (!isAbsolute(input.path) || ![".step", ".stp"].includes(extname(input.path).toLowerCase()))
        throw new Error("请选择 STEP 绝对路径。");
      const project = store.getProject(input.projectId);
      if (project?.mode !== "scene") throw new Error("场景项目不存在。");
      const saved = store.getScene(input.projectId);
      if (!saved || saved.revision !== input.revision) throw new Error("场景版本已变化。");
      const document = saved.document as Document;
      const index = document.models.findIndex(
        (model, position) => modelId(model, position) === input.modelId,
      );
      const model = document.models[index];
      if (!model) throw new Error("场景模型不存在。");
      const file = await open(input.path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size > 512 * 1024 * 1024)
          throw new Error("STEP 文件不可用或超过大小限制。");
        const hash = createHash("sha256");
        for await (const chunk of file.createReadStream({ autoClose: false }))
          hash.update(chunk as Buffer);
        const after = await file.stat();
        const selected = await stat(input.path);
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          selected.dev !== after.dev ||
          selected.ino !== after.ino ||
          selected.size !== after.size ||
          selected.mtimeMs !== after.mtimeMs ||
          selected.ctimeMs !== after.ctimeMs
        )
          throw new Error("STEP 在校验期间发生变化，请重试。");
        if (hash.digest("hex") !== model.source.sha256)
          throw new Error("所选 STEP 内容与原始文件哈希不一致。");
        const models = [...document.models];
        // 来源路径变化时保留原模型身份，避免破坏关节引用。
        models[index] = {
          ...model,
          stableId: input.modelId,
          source: { ...model.source, path: input.path },
          sourceStat: { size: after.size, mtimeMs: after.mtimeMs },
        };
        store.saveScene(input.projectId, input.revision, { ...document, models });
        return committed(input.projectId);
      } finally {
        await file.close();
      }
    },
    setTransform,
    deleteObject(input: {
      projectId: string;
      modelId: string;
      objectId: string;
      revision: number;
    }) {
      const saved = store.getScene(input.projectId);
      if (!saved || saved.revision !== input.revision)
        throw new Error("场景已被其他会话更新，请重新加载。");
      const document = saved.document as Document;
      const index = document.models.findIndex(
        (model, position) => modelId(model, position) === input.modelId,
      );
      const model = document.models[index];
      if (!model) throw new Error("场景模型不存在。");
      const models = [...document.models];
      models[index] = { ...model, objects: markDeletedSubtree(model.objects, input.objectId) };
      const next = { ...document, models };
      const joints = reconcileJointCandidates(
        document.joints ?? [],
        jointScene(next, input.revision + 1),
        [{ modelId: input.modelId, objectId: input.objectId }],
      );
      store.saveScene(input.projectId, input.revision, { ...next, joints });
      return committed(input.projectId);
    },

    createJointDraft(input: {
      projectId: string;
      revision: number;
      parent: JointObjectRef;
      child: JointObjectRef;
      type: "fixed" | "revolute" | "prismatic";
      axis?: JointAxis;
    }) {
      const saved = store.getScene(input.projectId);
      if (!saved || saved.revision !== input.revision) throw new Error("场景版本已变化。");
      const document = saved.document as Document;
      const existing = document.joints ?? [];
      if (existing.length >= 1000) throw new Error("关节候选数量超过限制。");
      const candidate = buildJointDraft(
        {
          id: randomUUID(),
          parent: input.parent,
          child: input.child,
          type: input.type,
          evidenceRevision: input.revision,
          ...(input.axis ? { axis: input.axis } : {}),
        },
        jointScene(document, saved.revision),
        existing,
      );
      store.saveScene(input.projectId, input.revision, {
        ...document,
        joints: [...existing, candidate],
      });
      return committed(input.projectId);
    },

    confirmJoint(input: { projectId: string; candidateId: string; revision: number }) {
      const saved = store.getScene(input.projectId);
      if (!saved || saved.revision !== input.revision) throw new Error("场景版本已变化。");
      const document = saved.document as Document;
      const existing = document.joints ?? [];
      const candidate = confirmJointDraft(
        input.candidateId,
        jointScene(document, saved.revision),
        existing,
        input.revision,
        "explicit-user",
      );
      store.saveScene(input.projectId, input.revision, {
        ...document,
        joints: existing.map((item) => (item.id === candidate.id ? candidate : item)),
      });
      return committed(input.projectId);
    },

    discardJointDraft(input: { projectId: string; candidateId: string; revision: number }) {
      return removeJoint(input, "draft");
    },

    removeConfirmedJoint(input: { projectId: string; candidateId: string; revision: number }) {
      return removeJoint(input, "confirmed");
    },

    bounds(input: { projectId: string; modelId: string; objectId: string }) {
      const { model, revision } = target(input.projectId, input.modelId);
      return { ...input, revision, bounds: getWorldBounds(model.objects, input.objectId) };
    },

    compareCylinders(input: {
      projectId: string;
      revision: number;
      first: { modelId: string; objectId: string; faceIndex: number };
      second: { modelId: string; objectId: string; faceIndex: number };
      tolerance: { angleRad: number; distanceM: number };
    }) {
      const first = target(input.projectId, input.first.modelId);
      const second = target(input.projectId, input.second.modelId);
      if (first.revision !== input.revision || second.revision !== input.revision)
        throw new Error("场景版本已变化。");
      return {
        projectId: input.projectId,
        revision: input.revision,
        ...compareCylinderAxes(
          { ...input.first, objects: first.model.objects },
          { ...input.second, objects: second.model.objects },
          input.tolerance,
        ),
      };
    },

    async measureDistance(
      input: {
        projectId: string;
        revision: number;
        first: { modelId: string; objectId: string };
        second: { modelId: string; objectId: string };
      },
      options: { signal?: AbortSignal } = {},
    ) {
      options.signal?.throwIfAborted();
      if (
        input.first.modelId === input.second.modelId &&
        input.first.objectId === input.second.objectId
      )
        throw new Error("请选择两个不同的场景对象。");
      const first = target(input.projectId, input.first.modelId);
      const second = target(input.projectId, input.second.modelId);
      if (first.revision !== input.revision || second.revision !== input.revision)
        throw new Error("场景版本已变化。");

      function argument(selection: typeof input.first, model: SavedModel) {
        const object = model.objects.find((item) => item.id === selection.objectId);
        if (!object || object.deleted) throw new Error("场景对象不存在或已删除。");
        if (!object.sourceKey || !object.geometryBounds)
          throw new Error("该对象没有可查询的 STEP 几何来源。");
        return {
          source: { ...model.source },
          sourceKey: object.sourceKey,
          worldTransform: getObjectWorldTransform(model.objects, object.id),
        };
      }

      const params = {
        first: argument(input.first, first.model),
        second: argument(input.second, second.model),
      };
      const runtime = await manager.get(input.projectId);
      options.signal?.throwIfAborted();
      const result = await runtime.call(
        "scene_measure_distance",
        params,
        options.signal ? { signal: options.signal } : {},
      );
      options.signal?.throwIfAborted();
      if (store.getScene(input.projectId)?.revision !== input.revision)
        throw new Error("场景版本已变化，距离结果已过期。");
      if (
        !Value.Check(distanceResultSchema, result) ||
        !Number.isFinite(result.shapeDistanceM) ||
        (result.innerSolution && (result.firstPoint !== null || result.secondPoint !== null)) ||
        (!result.innerSolution && (!result.firstPoint || !result.secondPoint)) ||
        [...(result.firstPoint ?? []), ...(result.secondPoint ?? [])].some(
          (value) => !Number.isFinite(value),
        )
      )
        throw new Error("场景 worker 返回的距离结果无效。");
      return {
        projectId: input.projectId,
        revision: input.revision,
        first: input.first,
        second: input.second,
        ...result,
      };
    },

    alignOrigin(input: { projectId: string; modelId: string; objectId: string; revision: number }) {
      const { model, revision } = target(input.projectId, input.modelId);
      if (input.revision !== revision) throw new Error("场景已被其他会话更新，请重新加载。");
      return setTransform({
        ...input,
        transform: alignBoundsToOrigin(model.objects, input.objectId),
      });
    },

    resolveResource(group: string, resourceId: string): ResourceLocation | undefined {
      const project = store.listProjects().find((entry) => resourceGroup(entry.id) === group);
      if (project?.mode !== "scene") return undefined;
      const document = store.getScene(project.id)?.document as Document | undefined;
      const model = document?.models.find((item) => item.resource.sha256 === resourceId);
      if (model)
        validateSceneResource(
          dataRoot,
          project.id,
          model.resource.path,
          resourceId,
          options.expectedRoot,
        );
      return (
        model && {
          projectId: project.id,
          mediaType: "model/gltf-binary",
          byteLength: model.resource.byteLength,
        }
      );
    },

    async release(projectId: string) {
      imports.get(projectId)?.abort();
      await manager.release(projectId);
    },

    async dispose() {
      for (const controller of imports.values()) controller.abort();
      await manager.dispose();
    },
  };
}
