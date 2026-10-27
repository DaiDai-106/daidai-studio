import { join } from "node:path";
import { projectFile } from "../../../resources/mcp/alignment/files.ts";
import type { ImportedModel } from "../../shared/display.ts";
import { readObjectCatalog } from "../artifacts/catalog.ts";
import { localFile } from "../artifacts/files.ts";
import type { Artifacts } from "../artifacts/store.ts";
import type { ObjectCatalog } from "../artifacts/types.ts";
import type { Placements } from "../projects/placements.ts";
import type { RunContext, SceneContext } from "./types.ts";

export async function sceneFiles(model: ImportedModel | null, sceneRoot: string) {
  if (!model) return null;
  const root = join(sceneRoot, "artifacts", model.importId);
  const manifest = join(root, "manifest.json");
  let catalog: ObjectCatalog | null = null;
  let catalogError: { code: string; message: string } | null = null;
  try {
    catalog = await readObjectCatalog(sceneRoot, model);
  } catch (error) {
    let code = "CATALOG_UNAVAILABLE";
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      try {
        await localFile(sceneRoot, manifest);
      } catch (checkError) {
        if ((checkError as NodeJS.ErrnoException | null)?.code === "ENOENT")
          code = "MANIFEST_MISSING";
      }
    }
    catalogError = {
      code,
      message: error instanceof Error ? error.message : "对象目录不可用。",
    };
  }
  const features = model.resources.find((file) => file.mediaType === "application/x-ndjson");
  let placement: string | null = null;
  try {
    placement = await projectFile(sceneRoot, ["placements", `${model.importId}.json`]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    manifest,
    objects: catalog?.objects ?? [],
    references: catalog?.references ?? [],
    catalogError,
    features: features ? join(root, "resources", features.sha256) : null,
    placement,
  };
}

export async function getSceneContext(
  run: RunContext,
  artifacts: Artifacts,
  placements: Placements,
): Promise<SceneContext> {
  await placements.flush();
  const model = run.sourceId ? await artifacts.get(run.sourceId) : null;
  return {
    currentDisplay: model
      ? {
          importId: model.importId,
          sourceHash: model.sourceHash,
          importFingerprint: model.importFingerprint,
          placement: await placements.get(model),
        }
      : null,
    files: await sceneFiles(model, await artifacts.directory(run.project.id)),
    sourceStatus: run.source
      ? model && model.sourceHash !== run.source.sha256
        ? "changed"
        : "current"
      : "missing",
    selectedSourcePath: run.selectedSourcePath ?? run.source?.path ?? null,
    currentFileHash: run.source?.sha256 ?? null,
  };
}
export function sceneFailure(code: string, message: string, scene: SceneContext) {
  return { ok: false, error: { code, message }, scene };
}
