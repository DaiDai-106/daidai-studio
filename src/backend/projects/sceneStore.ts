import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  type JointCandidate,
  reconcileJointCandidates,
} from "../../../packages/scene/src/joints.ts";
import { sceneModelId } from "./sceneIdentity.ts";
import { openSceneDataRoot, type RootIdentity } from "./scenePaths.ts";
import type { openProjectStore } from "./store.ts";

const hashSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const transformSchema = Type.Object(
  {
    position: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
    rotation: Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]),
  },
  { additionalProperties: false },
);
const boundsSchema = Type.Object(
  {
    min: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
    max: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
    size: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
    unit: Type.Literal("m"),
    space: Type.Literal("object-local"),
  },
  { additionalProperties: false },
);
const cylinderSchema = Type.Object(
  {
    faceIndex: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    axisOrigin: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
    axisDirection: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
    radius: Type.Number({ exclusiveMinimum: 0 }),
    unit: Type.Literal("m"),
    space: Type.Literal("object-local"),
    evidence: Type.Literal("analytic-cylinder"),
    kinematics: Type.Literal("unknown"),
  },
  { additionalProperties: false },
);
const SceneImportSchema = Type.Object(
  {
    source: Type.Object(
      { path: Type.String({ minLength: 1, maxLength: 4096 }), sha256: hashSchema },
      { additionalProperties: false },
    ),
    resource: Type.Object(
      {
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        format: Type.Literal("glb"),
        byteLength: Type.Integer({ minimum: 1, maximum: 512 * 1024 * 1024 }),
        sha256: hashSchema,
      },
      { additionalProperties: false },
    ),
    objects: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 200 }),
          name: Type.String({ maxLength: 2000 }),
          parentId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
          sourceKey: Type.Optional(Type.String({ maxLength: 4096 })),
          gltfNode: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
          baseTransform: Type.Optional(transformSchema),
          transform: Type.Optional(transformSchema),
          geometryBounds: Type.Optional(boundsSchema),
          rigidTransform: Type.Optional(Type.Boolean()),
          deleted: Type.Optional(Type.Boolean()),
          cylinderCandidates: Type.Optional(Type.Array(cylinderSchema, { maxItems: 64 })),
          cylinderCandidatesTruncated: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100000 },
    ),
    warnings: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 1000 }),
    complete: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SceneImport = import("typebox").Static<typeof SceneImportSchema>;

async function digestHandle(file: FileHandle, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false, signal }))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function directoryPath(directory: FileHandle, name?: string): string {
  const path = `/proc/self/fd/${directory.fd}`;
  return name ? join(path, name) : path;
}

/** Linux 通过目录句柄固定接管位置；不支持安全目录句柄的平台不能回退到普通路径。 */
async function openSceneDirectories(
  dataDir: string,
  projectId: string,
  dataRoot?: string,
  expectedRoot?: RootIdentity,
) {
  if (process.platform !== "linux" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY)
    throw new Error("当前系统不支持安全的场景资源接管。");
  const openedRoot = await openSceneDataRoot(dataRoot ?? dataDir, expectedRoot);
  const root = openedRoot.path;
  const scenePath = dataRoot ? join(root, "projects", projectId, "scene") : root;
  const configuredPath = dataRoot ? join(resolve(dataRoot), "projects", projectId, "scene") : root;
  if (
    (dataRoot && !/^[a-f0-9-]{36}$/.test(projectId)) ||
    (resolve(dataDir) !== scenePath && resolve(dataDir) !== configuredPath)
  ) {
    await openedRoot.handle.close();
    throw new Error("场景数据目录不在受控目录中。");
  }
  const handles: FileHandle[] = [openedRoot.handle];
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const openDirectory = async (path: string) => {
    try {
      const directory = await open(path, flags);
      handles.push(directory);
      return directory;
    } catch {
      throw new Error("场景目录包含符号链接或不可用。");
    }
  };
  try {
    let scene = openedRoot.handle;
    if (dataRoot) {
      for (const part of ["projects", projectId, "scene"])
        scene = await openDirectory(directoryPath(scene, part));
    }
    const staging = await openDirectory(directoryPath(scene, "staging"));
    const resourcesPath = directoryPath(scene, "resources");
    try {
      await mkdir(resourcesPath);
      await scene.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const resources = await openDirectory(resourcesPath);
    return {
      scenePath,
      scene,
      staging,
      resources,
      async close() {
        await Promise.all(handles.reverse().map((handle) => handle.close()));
      },
    };
  } catch (error) {
    await Promise.all(handles.reverse().map((handle) => handle.close()));
    throw error;
  }
}

async function checkDirectory(path: string, directory: FileHandle): Promise<void> {
  const [expected, current] = await Promise.all([directory.stat(), lstat(path)]);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    expected.dev !== current.dev ||
    expected.ino !== current.ino
  )
    throw new Error("场景目录在接管期间发生变化。");
}

async function takeSceneResource(options: {
  dataDir: string;
  dataRoot?: string;
  expectedRoot?: RootIdentity;
  projectId: string;
  resource: SceneImport["resource"];
  signal?: AbortSignal;
}) {
  const { dataDir, dataRoot, expectedRoot, projectId, resource, signal } = options;
  const directories = await openSceneDirectories(dataDir, projectId, dataRoot, expectedRoot);
  let staged: FileHandle | undefined;
  let temporary: FileHandle | undefined;
  let final: FileHandle | undefined;
  try {
    const stagingPath = join(directories.scenePath, "staging");
    const resourcesPath = join(directories.scenePath, "resources");
    if (!isAbsolute(resource.path) || dirname(resolve(resource.path)) !== stagingPath)
      throw new Error("场景产物不在受控目录中。");
    const stageName = basename(resource.path);
    try {
      staged = await open(
        directoryPath(directories.staging, stageName),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      throw new Error("场景产物包含符号链接或不可用。");
    }
    const original = await staged.stat();
    if (
      !original.isFile() ||
      original.nlink !== 1 ||
      original.size !== resource.byteLength ||
      original.size > 512 * 1024 * 1024
    )
      throw new Error("场景产物校验失败。");
    if ((await digestHandle(staged, signal)) !== resource.sha256)
      throw new Error("场景产物校验失败。");
    signal?.throwIfAborted();
    await checkDirectory(directories.scenePath, directories.scene);
    await checkDirectory(stagingPath, directories.staging);
    await checkDirectory(resourcesPath, directories.resources);
    const finalName = `${resource.sha256}.glb`;
    const pinnedFinal = directoryPath(directories.resources, finalName);
    const tempName = `.dai-resource-${randomUUID()}.tmp`;
    const pinnedTemp = directoryPath(directories.resources, tempName);
    temporary = await open(
      pinnedTemp,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    // 提交的资源不与暂存文件共享 inode；后续修改暂存文件不能破坏已保存场景。
    for await (const chunk of staged.createReadStream({ start: 0, autoClose: false, signal })) {
      signal?.throwIfAborted();
      const bytes = chunk as Buffer;
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await temporary.write(bytes, offset, bytes.length - offset);
        if (!bytesWritten) throw new Error("场景资源写入失败。");
        offset += bytesWritten;
      }
    }
    const tempInfo = await temporary.stat();
    if (
      tempInfo.size !== resource.byteLength ||
      (await digestHandle(temporary, signal)) !== resource.sha256
    )
      throw new Error("场景资源在复制期间发生变化。");
    await temporary.sync();
    signal?.throwIfAborted();
    let linked = false;
    try {
      // 原子排他创建硬链接；随后核对 inode，拒绝源目录项被替换的竞态。
      await link(pinnedTemp, pinnedFinal);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    signal?.throwIfAborted();
    await directories.resources.sync();
    try {
      final = await open(
        pinnedFinal,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      throw new Error("场景资源包含符号链接或不可用。");
    }
    const info = await final.stat();
    if (
      !info.isFile() ||
      info.size !== resource.byteLength ||
      (linked && (info.dev !== tempInfo.dev || info.ino !== tempInfo.ino)) ||
      (await digestHandle(final, signal)) !== resource.sha256
    )
      throw new Error("场景资源校验失败或在接管期间发生变化。");
    signal?.throwIfAborted();
    await checkDirectory(directories.scenePath, directories.scene);
    await checkDirectory(stagingPath, directories.staging);
    await checkDirectory(resourcesPath, directories.resources);
    const finalEntry = await lstat(pinnedFinal);
    if (
      finalEntry.isSymbolicLink() ||
      !finalEntry.isFile() ||
      finalEntry.dev !== info.dev ||
      finalEntry.ino !== info.ino
    )
      throw new Error("场景资源在接管期间发生变化。");
    // 不通过目录项 unlink 暂存文件：目录项可在身份校验后被替换为无关文件。
    return { path: join(resourcesPath, finalName), size: info.size };
  } finally {
    await Promise.allSettled([staged?.close(), temporary?.close(), final?.close()]);
    await directories.close();
  }
}

/** 接管 worker 产物后才提交场景；外部 STEP 始终只保存引用。 */
export async function commitSceneImport(options: {
  store: ReturnType<typeof openProjectStore>;
  dataDir: string;
  projectId: string;
  expectedRevision: number;
  approvedStepPath: string;
  result: unknown;
  operation?: "replace" | "append";
  dataRoot?: string;
  expectedRoot?: RootIdentity;
  signal?: AbortSignal;
}) {
  const { store, dataDir, projectId, expectedRevision, approvedStepPath } = options;
  options.signal?.throwIfAborted();
  if (!Value.Check(SceneImportSchema, options.result))
    throw new Error("场景 worker 返回数据无效。");
  const result = options.result;
  const project = store.getProject(projectId);
  if (project?.mode !== "scene") throw new Error("场景项目不存在。");
  if (
    !isAbsolute(approvedStepPath) ||
    (await realpath(result.source.path)) !== (await realpath(approvedStepPath))
  )
    throw new Error("场景来源与授权的 STEP 不一致。");
  // 保留用户选择的符号链接语义，打开后仅读取固定的普通文件句柄。
  const sourceFile = await open(approvedStepPath, constants.O_RDONLY | constants.O_NONBLOCK);
  let sourceStat: Awaited<ReturnType<typeof sourceFile.stat>>;
  try {
    sourceStat = await sourceFile.stat();
    if (!sourceStat.isFile() || sourceStat.size > 512 * 1024 * 1024)
      throw new Error("STEP 文件不可用或超过大小限制。");
    if ((await digestHandle(sourceFile, options.signal)) !== result.source.sha256)
      throw new Error("STEP 已发生变化，请重新导入。");
    const selected = await stat(approvedStepPath);
    if (
      selected.dev !== sourceStat.dev ||
      selected.ino !== sourceStat.ino ||
      selected.size !== sourceStat.size ||
      selected.mtimeMs !== sourceStat.mtimeMs ||
      selected.ctimeMs !== sourceStat.ctimeMs
    )
      throw new Error("STEP 已发生变化，请重新导入。");
  } finally {
    await sourceFile.close();
  }
  options.signal?.throwIfAborted();
  if (result.resource.format !== "glb" || !/^[a-f0-9]{64}$/.test(result.resource.sha256))
    throw new Error("场景产物格式无效。");
  const resource = await takeSceneResource({
    dataDir,
    projectId,
    resource: result.resource,
    ...(options.dataRoot ? { dataRoot: options.dataRoot } : {}),
    ...(options.expectedRoot ? { expectedRoot: options.expectedRoot } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  options.signal?.throwIfAborted();
  const model = {
    source: result.source,
    sourceStat: { size: sourceStat.size, mtimeMs: sourceStat.mtimeMs },
    resource: {
      path: resource.path,
      format: "glb",
      byteLength: resource.size,
      sha256: result.resource.sha256,
    },
    objects: result.objects,
    warnings: result.warnings,
    complete: result.complete,
  };
  const previous = store.getScene(projectId);
  const previousDocument = previous?.document as
    | {
        models?: (SceneImport & { sourceStat?: { size: number; mtimeMs: number } })[];
        joints?: JointCandidate[];
      }
    | undefined;
  const models =
    options.operation === "append" ? [...(previousDocument?.models ?? []), model] : [model];
  options.signal?.throwIfAborted();
  const joints = reconcileJointCandidates(
    previousDocument?.joints ?? [],
    {
      revision: expectedRevision + 1,
      models: models.map((item, index) => ({
        id: sceneModelId(item, index),
        objects: item.objects,
      })),
    },
    [],
  );
  return store.saveScene(projectId, expectedRevision, { models, joints });
}
