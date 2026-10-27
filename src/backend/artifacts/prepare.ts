import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { type CadResource, DisplayArtifactSchema } from "../../../resources/mcp/cad/contract.ts";
import { displayResourceUrl } from "../../shared/display.ts";
import type { RunContext } from "../agent/types.ts";
import { fileHash } from "../projects/source.ts";
import { writeObjectCatalog } from "./catalog.ts";
import { artifactDirectory, copyResource, localFile } from "./files.ts";
import {
  type PreparedDisplay,
  PreparedDisplaySchema,
  type ResourceScope,
  type StoredResource,
} from "./types.ts";
import {
  readMetadata,
  validateFeatureCache,
  validateGeometry,
  validateManifest,
} from "./validation.ts";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export async function readPreparedDisplay(
  sceneRoot: string,
  importId: string,
): Promise<PreparedDisplay> {
  const root = await artifactDirectory(sceneRoot);
  const path = await localFile(root, join(root, importId, "metadata.json"));
  const value = await readMetadata(path);
  if (!Value.Check(PreparedDisplaySchema, value) || value.model.importId !== importId)
    throw new Error("保存的显示产物元数据无效。");
  for (const file of value.files) {
    const path = await localFile(root, join(root, importId, file.file), file.byteLength);
    if ((await fileHash(path, file.byteLength)).sha256 !== file.sha256)
      throw new Error("已保存的显示资源校验失败。");
  }
  return value;
}

export async function prepareDisplayArtifact(
  value: unknown,
  scope: ResourceScope,
  run: RunContext,
  signal: AbortSignal,
  sceneRoot: string,
) {
  signal.throwIfAborted();
  if (
    !Value.Check(DisplayArtifactSchema, value) ||
    !run.source ||
    value.source.sourceHash !== run.source.sha256 ||
    value.source.path !== run.source.path
  )
    throw new Error("显示产物与本轮选中的 STEP 版本不匹配。");
  const artifact = value;
  const registered = new Set(
    (await scope.client.listResources({ signal })).map((resource) => resource.uri),
  );
  const resourcePath = async (resource: CadResource) => {
    if (!registered.has(resource.uri)) throw new Error("MCP 服务未登记显示资源。");
    return localFile(scope.root, fileURLToPath(resource.uri), resource.byteLength);
  };
  if (
    artifact.manifest.mediaType !== "application/json" ||
    artifact.manifest.byteLength > 32 * 1024 * 1024
  )
    throw new Error("显示清单类型或大小无效。");
  const manifestPath = await resourcePath(artifact.manifest);
  const bytes = await readFile(manifestPath);
  if (bytes.length !== artifact.manifest.byteLength || digest(bytes) !== artifact.manifest.sha256)
    throw new Error("显示清单校验失败。");
  const manifest = validateManifest(JSON.parse(bytes.toString("utf8")), run.source);
  if (manifest.source.importFingerprint !== artifact.source.importFingerprint)
    throw new Error("显示产物的导入方式不一致。");
  const glbs = manifest.resources.filter((resource) => resource.mediaType === "model/gltf-binary");
  const faces = manifest.resources.filter((resource) => resource.mediaType === "application/json");
  const features = manifest.resources.filter((resource) => resource.role === "geometry-features");
  if (
    glbs.length !== 1 ||
    faces.length !== 1 ||
    features.length > 1 ||
    manifest.resources.length !== 2 + features.length ||
    (manifest.features ? manifest.features.resourceUri !== features[0]?.uri : features.length > 0)
  )
    throw new Error("当前仅支持 CAD 的独立 GLB 和面映射资源。");
  if (
    manifest.resources.reduce((sum, resource) => sum + resource.byteLength, bytes.length) >
    2 * 1024 ** 3
  )
    throw new Error("显示资源超过接管大小限制。");
  const importId = digest(
    JSON.stringify([
      run.project.id,
      run.source.id,
      scope.root,
      artifact.manifest.uri,
      artifact.manifest.sha256,
    ]),
  );
  const ref = { importId, sourceId: run.source.id, sourceHash: run.source.sha256 };
  const root = await artifactDirectory(sceneRoot);
  try {
    await readPreparedDisplay(sceneRoot, importId);
    return ref;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(join(root, ".prepare-"));
  try {
    await mkdir(join(staging, "resources"));
    const files: StoredResource[] = [];
    const urls = new Map<string, string>();
    for (const resource of manifest.resources) {
      const id = resource.sha256;
      const file = `resources/${id}`;
      await copyResource(await resourcePath(resource), join(staging, file), resource, signal);
      const url = displayResourceUrl(importId, id);
      urls.set(resource.uri, url);
      files.push({
        id,
        file,
        url,
        mediaType: resource.mediaType,
        byteLength: resource.byteLength,
        sha256: id,
      });
    }
    const glb = glbs[0];
    const faceMap = faces[0];
    if (!glb || !faceMap) throw new Error("缺少 CAD 显示资源。");
    await validateGeometry(
      join(staging, "resources", glb.sha256),
      glb.byteLength,
      manifest,
      join(staging, "resources", faceMap.sha256),
    );
    const featureResource = features[0];
    if (featureResource)
      await validateFeatureCache(
        join(staging, "resources", featureResource.sha256),
        manifest,
        signal,
      );
    const published = {
      ...manifest,
      ...(manifest.features
        ? {
            features: {
              ...manifest.features,
              resourceUri: urls.get(manifest.features.resourceUri),
            },
          }
        : {}),
      resources: manifest.resources.map((resource) => ({
        ...resource,
        uri: urls.get(resource.uri),
      })),
      objects: manifest.objects.map((object) => ({
        ...object,
        ...(object.geometryResourceUri
          ? { geometryResourceUri: urls.get(object.geometryResourceUri) }
          : {}),
      })),
    };
    const content = Buffer.from(JSON.stringify(published, null, 2));
    const id = digest(content);
    const descriptor = {
      id,
      url: displayResourceUrl(importId, id),
      mediaType: "application/json",
      byteLength: content.length,
      sha256: id,
    };
    const model = {
      ...ref,
      projectId: run.project.id,
      importFingerprint: manifest.source.importFingerprint,
      createdAt: new Date().toISOString(),
      manifest: descriptor,
      resources: files.map(({ file: _file, ...resource }) => resource),
      warnings: manifest.warnings,
    };
    const metadata: PreparedDisplay = {
      model,
      files: [...files, { ...descriptor, file: "manifest.json" }],
    };
    await writeFile(join(staging, "manifest.json"), content, { mode: 0o600 });
    await writeObjectCatalog(staging, manifest);
    await writeFile(join(staging, "metadata.json"), JSON.stringify(metadata), { mode: 0o600 });
    signal.throwIfAborted();
    await rename(staging, join(root, importId));
    return ref;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
