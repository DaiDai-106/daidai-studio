import { open, readFile, stat } from "node:fs/promises";
import { Value } from "typebox/value";
import {
  type CadFaceMap,
  CadFaceMapSchema,
  type CadManifest,
  CadManifestSchema,
} from "../../../resources/mcp/cad/contract.ts";

export async function readMetadata(path: string): Promise<unknown> {
  if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error("显示清单超过大小限制。");
  return JSON.parse(await readFile(path, "utf8"));
}

export function validateManifest(
  value: unknown,
  source: { path: string; sha256: string },
): CadManifest {
  if (!Value.Check(CadManifestSchema, value)) throw new Error("显示清单无效，保留上次显示。");
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

interface GlbData {
  asset?: { version?: string };
  buffers?: { uri?: string; byteLength: number }[];
  images?: unknown[];
  nodes?: {
    children?: number[];
    mesh?: number;
    extras?: { objectId?: string; sourceKey?: string };
  }[];
  meshes?: { primitives: { indices: number; mode?: number }[] }[];
  accessors?: { count: number }[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
}

// Native display GLBs must be self-contained; no external buffers, images or URLs.
export async function validateGeometry(
  path: string,
  byteLength: number,
  manifest: CadManifest,
  facesPath: string,
) {
  const file = await open(path, "r");
  let data: GlbData;
  let binaryLength = 0;
  try {
    const header = Buffer.alloc(20);
    if (
      (await file.read(header, 0, header.length, 0)).bytesRead !== 20 ||
      header.toString("ascii", 0, 4) !== "glTF" ||
      header.readUInt32LE(4) !== 2 ||
      header.readUInt32LE(8) !== byteLength ||
      header.readUInt32LE(16) !== 0x4e4f534a
    )
      throw new Error("GLB 文件头或长度无效。");
    const length = header.readUInt32LE(12);
    if (length > 32 * 1024 * 1024 || length > byteLength - 20)
      throw new Error("GLB 结构超过大小限制。");
    const json = Buffer.alloc(length);
    if ((await file.read(json, 0, length, 20)).bytesRead !== length)
      throw new Error("GLB 结构不完整。");
    data = JSON.parse(json.toString("utf8"));
    const binary = Buffer.alloc(8);
    if (
      (await file.read(binary, 0, 8, 20 + length)).bytesRead !== 8 ||
      binary.readUInt32LE(4) !== 0x004e4942
    )
      throw new Error("GLB 缺少二进制几何块。");
    binaryLength = binary.readUInt32LE(0);
    if (28 + length + binaryLength !== byteLength) throw new Error("GLB 二进制块长度无效。");
  } finally {
    await file.close();
  }
  if (
    data.asset?.version !== "2.0" ||
    !data.nodes?.length ||
    !data.meshes?.length ||
    !data.accessors?.length ||
    data.buffers?.length !== 1 ||
    data.buffers.some((buffer) => Object.hasOwn(buffer, "uri")) ||
    data.images?.length
  )
    throw new Error("GLB 必须是包含几何的独立二进制模型。");
  const bufferLength = data.buffers[0]?.byteLength;
  if (!bufferLength || bufferLength > binaryLength || binaryLength - bufferLength > 3)
    throw new Error("GLB 缓冲区长度无效。");
  const nodes = data.nodes;
  const meshes = data.meshes;
  const accessors = data.accessors;
  const primary = new Map<string, number>();
  for (const [index, node] of nodes.entries()) {
    if (node.extras?.objectId) {
      if (primary.has(node.extras.objectId)) throw new Error("GLB 对象节点重复。");
      primary.set(node.extras.objectId, index);
    }
    if (node.mesh !== undefined && (!Number.isInteger(node.mesh) || !meshes[node.mesh]))
      throw new Error("GLB 网格索引无效。");
    for (const child of node.children ?? [])
      if (!Number.isInteger(child) || !nodes[child]) throw new Error("GLB 子节点索引无效。");
  }
  if (primary.size !== manifest.objects.length) throw new Error("GLB 对象数量与清单不一致。");
  const roots = data.scenes?.[data.scene ?? 0]?.nodes;
  if (
    !roots ||
    data.scenes?.length !== 1 ||
    JSON.stringify([...roots].sort((a, b) => a - b)) !==
      JSON.stringify(
        manifest.roots.map((id) => primary.get(id)).sort((a, b) => (a ?? -1) - (b ?? -1)),
      )
  )
    throw new Error("GLB 根节点与清单不一致。");
  const pendingNodes = [...roots];
  const reachable = new Set<number>();
  while (pendingNodes.length) {
    const id = pendingNodes.pop();
    if (id === undefined || reachable.has(id) || !nodes[id])
      throw new Error("GLB 节点树存在环或重复实例。");
    reachable.add(id);
    pendingNodes.push(...(nodes[id]?.children ?? []));
  }
  if (reachable.size !== nodes.length) throw new Error("GLB 包含未声明的游离节点。");
  const geometryByMesh = new Map<number, string>();
  for (const object of manifest.objects) {
    const index = primary.get(object.nodeKey);
    if (index === undefined || nodes[index]?.extras?.sourceKey !== object.sourceKey)
      throw new Error("GLB 与显示清单的对象映射不一致。");
    const node = nodes[index];
    if (!node) throw new Error("GLB 缺少对象节点。");
    if (
      object.parentObjectId &&
      !nodes[primary.get(object.parentObjectId) ?? -1]?.children?.includes(index)
    )
      throw new Error("GLB 与显示清单的层级不一致。");
    if (!object.geometryId) continue;
    const pending = [index];
    const visited = new Set<number>();
    let hasMesh = false;
    while (pending.length) {
      const current = pending.pop();
      if (current === undefined || visited.has(current)) throw new Error("GLB 节点存在环。");
      visited.add(current);
      const part = nodes[current];
      if (!part) throw new Error("GLB 节点无效。");
      if (current !== index && part.extras?.objectId) continue;
      if (part.mesh !== undefined) {
        hasMesh = true;
        const previous = geometryByMesh.get(part.mesh);
        if (previous && previous !== object.geometryId) throw new Error("GLB 几何映射冲突。");
        geometryByMesh.set(part.mesh, object.geometryId);
      }
      pending.push(...(part.children ?? []));
    }
    const unavailable =
      !!object.display && object.display.faceCount === object.display.omittedFaceCount;
    if (hasMesh === unavailable) throw new Error("GLB 与对象的显示可用性不一致。");
  }
  const faceMap = await readMetadata(facesPath);
  if (
    !Value.Check(CadFaceMapSchema, faceMap) ||
    faceMap.sourceHash !== manifest.source.sourceHash ||
    faceMap.importFingerprint !== manifest.source.importFingerprint
  )
    throw new Error("CAD 面映射与显示来源不一致。");
  validateFaceRanges(faceMap, meshes, accessors, geometryByMesh);
  validateOmittedFaces(faceMap, manifest);
}

function validateOmittedFaces(faces: CadFaceMap, manifest: CadManifest) {
  if (manifest.omittedFaceCount === undefined) {
    if (faces.omittedFaces?.length) throw new Error("显示清单未声明排除面。");
    return;
  }
  if (!faces.omittedFaces || faces.omittedFaces.length !== manifest.omittedFaceCount)
    throw new Error("排除面清单与显示计数不一致。");
  const key = (geometryId: string, faceId: string) => JSON.stringify([geometryId, faceId]);
  const shown = new Set(faces.ranges.map((range) => key(range.geometryId, range.topologyRef.id)));
  const displayedByGeometry = new Map<string, Set<string>>();
  for (const range of faces.ranges) {
    const ids = displayedByGeometry.get(range.geometryId) ?? new Set<string>();
    ids.add(range.topologyRef.id);
    displayedByGeometry.set(range.geometryId, ids);
  }
  const omitted = new Set<string>();
  const counts = new Map<string, number>();
  const geometries = new Map(
    manifest.objects
      .filter((object) => object.geometryId)
      .map((object) => [object.geometryId, object.display]),
  );
  for (const face of faces.omittedFaces) {
    const id = key(face.geometryId, face.topologyRef.id);
    if (
      !geometries.has(face.geometryId) ||
      face.topologyRef.kind !== "face" ||
      omitted.has(id) ||
      shown.has(id)
    )
      throw new Error("排除面重复、未知或仍包含在显示网格中。");
    omitted.add(id);
    counts.set(face.geometryId, (counts.get(face.geometryId) ?? 0) + 1);
  }
  for (const [geometryId, display] of geometries) {
    if (!geometryId || !display) throw new Error("几何缺少显示面计数。");
    const displayed = displayedByGeometry.get(geometryId)?.size ?? 0;
    if (
      (counts.get(geometryId) ?? 0) !== display.omittedFaceCount ||
      displayed + display.omittedFaceCount !== display.faceCount
    )
      throw new Error("CAD 显示面与排除面未覆盖原面计数。");
  }
}

function validateFaceRanges(
  faces: CadFaceMap,
  meshes: NonNullable<GlbData["meshes"]>,
  accessors: NonNullable<GlbData["accessors"]>,
  geometryByMesh: Map<number, string>,
) {
  const ranges = new Map<string, typeof faces.ranges>();
  for (const range of faces.ranges) {
    if (
      range.topologyRef.kind !== "face" ||
      geometryByMesh.get(range.meshIndex) !== range.geometryId ||
      !meshes[range.meshIndex]?.primitives[range.primitiveIndex]
    )
      throw new Error("CAD 面映射引用未知几何。");
    const key = `${range.meshIndex}:${range.primitiveIndex}`;
    const items = ranges.get(key) ?? [];
    items.push(range);
    ranges.set(key, items);
  }
  for (const [meshIndex, mesh] of meshes.entries()) {
    for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
      const count = accessors[primitive.indices]?.count;
      if (
        !count ||
        !Number.isSafeInteger(count) ||
        count % 3 ||
        (primitive.mode !== undefined && primitive.mode !== 4)
      )
        throw new Error("GLB 不是有效的三角网格。");
      let covered = 0;
      for (const range of (ranges.get(`${meshIndex}:${primitiveIndex}`) ?? []).sort(
        (a, b) => a.firstTriangle - b.firstTriangle,
      )) {
        if (range.firstTriangle !== covered) throw new Error("CAD 面映射存在缺口或重叠。");
        covered += range.triangleCount;
      }
      if (covered !== count / 3) throw new Error("CAD 面映射未覆盖全部显示三角形。");
    }
  }
}
