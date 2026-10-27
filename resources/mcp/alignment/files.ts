import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { CadManifestSchema } from "../cad/contract.ts";
import { decodePlacement, type Placement, PlacementSchema } from "./contract.ts";

// Shared on-disk placement format. The desktop writes; plugins only read.
export async function projectFile(project: string, parts: string[]) {
  let path = await realpath(project);
  let info: Stats | undefined;
  for (const part of parts) {
    path = join(path, part);
    info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Linked project resources are not supported.");
  }
  if (!(info ?? (await lstat(path))).isFile())
    throw new Error("Expected a regular project resource.");
  return path;
}
export async function readPlacement(
  sceneRoot: string,
  importId: string,
  sourceHash: string,
): Promise<Placement> {
  const initial: Placement = {
    schemaVersion: 2,
    importId,
    sourceHash,
    revision: 0,
    translation: [0, 0, 0],
    rotation: [0, 0, 0, 1],
  };
  if (!Value.Check(PlacementSchema, initial)) throw new Error("Invalid placement identity.");
  try {
    const path = await projectFile(sceneRoot, ["placements", `${importId}.json`]);
    if ((await lstat(path)).size > 8192) throw new Error("Invalid placement size.");
    const value = decodePlacement(JSON.parse(await readFile(path, "utf8")));
    if (!value || value.importId !== importId || value.sourceHash !== sourceHash)
      throw new Error("Invalid saved placement.");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return initial;
  }
}
export async function writePlacement(sceneRoot: string, value: Placement) {
  if (!decodePlacement(value)) throw new Error("Invalid placement.");
  let root = await realpath(sceneRoot);
  for (const part of ["placements"]) {
    root = join(root, part);
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Invalid placement directory.");
  }
  try {
    const current = await lstat(join(root, `${value.importId}.json`));
    if (!current.isFile() || current.isSymbolicLink()) throw new Error("Invalid placement file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(join(root, ".placement-"));
  try {
    const file = join(staging, "placement.json");
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    await rename(file, join(root, `${value.importId}.json`));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// Resolve and verify resources from the saved bundle, never from model-provided paths.
export async function loadSavedModel(sceneRoot: string, importId: string, signal: AbortSignal) {
  if (!/^[0-9a-f]{64}$/.test(importId)) throw new Error("Invalid imported model identity.");
  const parts = ["artifacts", importId];
  const manifestPath = await projectFile(sceneRoot, [...parts, "manifest.json"]);
  if ((await lstat(manifestPath)).size > 32 * 1024 ** 2) throw new Error("Manifest is too large.");
  const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Value.Check(CadManifestSchema, value)) throw new Error("Invalid CAD display manifest.");
  const manifest = value;
  async function resource(uri: string, limit: number) {
    const file = manifest.resources.find((item) => item.uri === uri);
    if (
      !file ||
      file.uri !== `dai-resource://${importId}/${file.sha256}` ||
      file.byteLength > limit
    )
      throw new Error("Unsupported saved model resource.");
    const path = await projectFile(sceneRoot, [...parts, "resources", file.sha256]);
    if ((await lstat(path)).size !== file.byteLength) throw new Error("Resource size mismatch.");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
    if (hash.digest("hex") !== file.sha256) throw new Error("Resource hash mismatch.");
    return path;
  }
  const glb = manifest.resources.filter((item) => item.mediaType === "model/gltf-binary");
  if (glb.length !== 1 || !glb[0]) throw new Error("Missing standalone GLB resource.");
  const glbPath = await resource(glb[0].uri, 2 * 1024 ** 3);
  const featuresPath = manifest.features
    ? await resource(manifest.features.resourceUri, 32 * 1024 ** 2)
    : undefined;
  return { manifest, manifestPath, glbPath, featuresPath };
}
