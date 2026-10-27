import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Value } from "typebox/value";
import { CadFeatureSchema, type CadManifest } from "../../../../resources/mcp/cad/contract.ts";

// Check cached identities and paging before publication; display completeness remains independent.
export async function validateFeatureCache(
  path: string,
  manifest: CadManifest,
  signal: AbortSignal,
) {
  const index = manifest.features;
  if (!index || (await stat(path)).size > 32 * 1024 ** 2) throw new Error("几何特征缓存无效。");
  const objects = new Map(manifest.objects.map((object) => [object.objectId, object]));
  let expectedLine = 2;
  const ranges = new Map<string, (typeof index.objects)[number]>();
  for (const item of index.objects) {
    if (
      !objects.get(item.objectId)?.geometryId ||
      ranges.has(item.objectId) ||
      item.startLine !== expectedLine
    )
      throw new Error("几何特征分页或对象身份无效。");
    expectedLine += item.count;
    ranges.set(item.objectId, item);
  }
  const stream = createReadStream(path, { signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  const ids = new Set<string>();
  try {
    for await (const text of lines) {
      signal.throwIfAborted();
      line++;
      if (Buffer.byteLength(text) > 16384) throw new Error("几何特征行超过限制。");
      const record = JSON.parse(text);
      if (line === 1) {
        if (
          record.schemaVersion !== 1 ||
          record.sourceHash !== manifest.source.sourceHash ||
          record.importFingerprint !== manifest.source.importFingerprint ||
          record.unit !== "m" ||
          record.space !== "object"
        )
          throw new Error("几何特征缓存版本不匹配。");
        continue;
      }
      if (!record || typeof record !== "object" || Array.isArray(record))
        throw new Error("几何特征记录无效。");
      const { geometryId, ...feature } = record;
      if (
        !Value.Check(CadFeatureSchema, feature) ||
        !["plane_center", "circle_center", "cylinder_axis"].includes(feature.type)
      )
        throw new Error("几何特征内容无效。");
      const range = ranges.get(feature.objectId);
      const key = `${feature.objectId}/${feature.featureId}`;
      if (
        !range ||
        line < range.startLine ||
        line >= range.startLine + range.count ||
        objects.get(feature.objectId)?.geometryId !== geometryId ||
        ids.has(key)
      )
        throw new Error("几何特征与显示对象不匹配。");
      ids.add(key);
    }
    if (line + 1 !== expectedLine) throw new Error("几何特征缓存行数不完整。");
  } finally {
    lines.close();
    stream.destroy();
  }
}
