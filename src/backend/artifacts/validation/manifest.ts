import { Value } from "typebox/value";
import { type CadManifest, CadManifestSchema } from "../../../../resources/mcp/cad/contract.ts";

export function validateManifest(
  value: unknown,
  source: { path: string; sha256: string },
): CadManifest {
  if (!Value.Check(CadManifestSchema, value)) throw new Error("显示清单结构无效。");
  if (!value.complete && value.omittedFaceCount === undefined)
    throw new Error("部分显示缺少明确的面排除记录，保留上次显示。");
  if (value.source.path !== source.path || value.source.sourceHash !== source.sha256)
    throw new Error("显示产物不属于本轮选中的 STEP 版本。");
  const objects = new Map(value.objects.map((object) => [object.objectId, object]));
  if (
    !objects.size ||
    objects.size !== value.objects.length ||
    objects.size > 100_000 ||
    new Set(value.objects.map((object) => object.nodeKey)).size !== objects.size
  )
    throw new Error("显示对象身份重复、为空或超过限制。");
  const children = new Map<string, string[]>();
  const roots = new Set(value.roots);
  if (roots.size !== value.roots.length) throw new Error("显示根对象重复。");
  const resources = new Set(value.resources.map((resource) => resource.uri));
  if (resources.size !== value.resources.length) throw new Error("显示资源重复。");
  const geometries = new Map<string, NonNullable<CadManifest["objects"][number]["display"]>>();
  for (const object of objects.values()) {
    const display = object.display;
    if (display) {
      if (!object.geometryId || display.omittedFaceCount > display.faceCount)
        throw new Error("对象的显示面计数无效。");
      const previous = geometries.get(object.geometryId);
      if (
        previous &&
        (previous.faceCount !== display.faceCount ||
          previous.omittedFaceCount !== display.omittedFaceCount)
      )
        throw new Error("同一几何实例的显示面计数不一致。");
      geometries.set(object.geometryId, display);
    }
    if (object.geometryId && value.omittedFaceCount !== undefined && !display)
      throw new Error("显示对象缺少面计数。");
    const omitted = display && display.faceCount === display.omittedFaceCount;
    if (
      object.nodeKey !== object.objectId ||
      (object.geometryId &&
        (omitted
          ? !!object.geometryResourceUri
          : !object.geometryResourceUri || !resources.has(object.geometryResourceUri))) ||
      (object.parentObjectId
        ? !objects.has(object.parentObjectId) || roots.has(object.objectId)
        : !roots.has(object.objectId))
    )
      throw new Error("显示对象的父子关系或网格引用无效。");
    if (object.parentObjectId) {
      const list = children.get(object.parentObjectId) ?? [];
      list.push(object.objectId);
      children.set(object.parentObjectId, list);
    }
  }
  if (value.omittedFaceCount !== undefined) {
    const total = [...geometries.values()].reduce((sum, item) => sum + item.omittedFaceCount, 0);
    if (total !== value.omittedFaceCount || (value.complete && total > 0))
      throw new Error("显示排除面计数与完整性不一致。");
  }
  const visited = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const id = pending.pop();
    if (!id || !objects.has(id) || visited.has(id)) throw new Error("显示对象树存在无效节点或环。");
    visited.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  if (visited.size !== objects.size) throw new Error("显示对象树包含不可达对象。");
  return value;
}
