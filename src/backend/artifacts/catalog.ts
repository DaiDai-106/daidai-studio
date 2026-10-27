import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CadManifest } from "../../../resources/mcp/cad/contract.ts";
import type { ImportedModel } from "../../shared/display.ts";
import { localFile } from "./files.ts";
import type { CatalogPage, ObjectCatalog } from "./types.ts";
import { validateManifest } from "./validation.ts";

// Leave room below Pi's 50 KiB / 2,000-line limits for its truncation bookkeeping.
const pageBytes = 48 * 1024;
const pageLines = 1000;

async function writePages(root: string, kind: string, records: unknown[]): Promise<CatalogPage[]> {
  const pages: CatalogPage[] = [];
  let lines: string[] = [];
  let bytes = 0;
  let startIndex = 0;
  async function flush() {
    if (!lines.length) return;
    const content = lines.join("");
    const hash = createHash("sha256").update(content).digest("hex");
    const path = join(root, `${kind}-${hash}.jsonl`);
    try {
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await localFile(root, path, bytes);
      if (!(await readFile(path)).equals(Buffer.from(content)))
        throw new Error("对象目录校验失败。");
    }
    pages.push({ path, byteLength: bytes, objectCount: lines.length, startIndex });
    startIndex += lines.length;
    lines = [];
    bytes = 0;
  }
  for (const record of records) {
    const line = `${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(line);
    if (size > pageBytes) throw new Error("单个对象的目录信息超过读取上限。");
    if (lines.length && (bytes + size > pageBytes || lines.length >= pageLines)) await flush();
    lines.push(line);
    bytes += size;
  }
  await flush();
  return pages;
}

/** Derived from the registered manifest; never changes the manifest, geometry or saved pose.
 * Rebuild on demand so older imports work without reimporting their source STEP.
 */
export async function readObjectCatalog(
  sceneRoot: string,
  model: ImportedModel,
): Promise<ObjectCatalog> {
  const root = join(sceneRoot, "artifacts", model.importId);
  const path = await localFile(sceneRoot, join(root, "manifest.json"), model.manifest.byteLength);
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== model.manifest.sha256)
    throw new Error("已保存的显示清单校验失败。");
  // Validate against the saved version, not the possibly changed/missing source on disk.
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  // Extract the path needed by validateManifest, which performs the full schema check.
  const source = value && typeof value === "object" && "source" in value ? value.source : null;
  if (
    !source ||
    typeof source !== "object" ||
    !("path" in source) ||
    typeof source.path !== "string"
  )
    throw new Error("显示清单结构无效。");
  const manifest = validateManifest(value, { path: source.path, sha256: model.sourceHash });
  if (manifest.source.importFingerprint !== model.importFingerprint)
    throw new Error("保存场景的导入方式与目录不一致。");
  return writeObjectCatalog(root, manifest);
}

export async function writeObjectCatalog(
  root: string,
  manifest: CadManifest,
): Promise<ObjectCatalog> {
  const ranges = new Map(manifest.features?.objects.map((item) => [item.objectId, item]));
  return {
    objectCount: manifest.objects.length,
    objects: await writePages(
      root,
      "objects",
      manifest.objects.map((item) => ({
        objectId: item.objectId,
        ...(item.parentObjectId ? { parentObjectId: item.parentObjectId } : {}),
        name: item.name,
        kind: item.kind,
      })),
    ),
    references: await writePages(
      root,
      "references",
      manifest.objects.map((item) => {
        const range = ranges.get(item.objectId);
        return {
          objectId: item.objectId,
          sourceKey: item.sourceKey,
          ...(range
            ? {
                features: {
                  startLine: range.startLine,
                  count: range.count,
                  analysisComplete: range.analysisComplete,
                },
              }
            : {}),
        };
      }),
    ),
  };
}
