/** 与 Dai 前端一致的 Z-up 世界坐标；输入位置与边界使用米。 */
export type Vector3 = [number, number, number];
export type Quaternion = [number, number, number, number];
export type SceneTransform = { position: Vector3; rotation: Quaternion };
export type CylinderCandidate = {
  faceIndex: number;
  axisOrigin: Vector3;
  axisDirection: Vector3;
  radius: number;
  unit: "m";
  space: "object-local";
  evidence: "analytic-cylinder";
  kinematics: "unknown";
};
export type SceneObject = {
  id: string;
  parentId: string | null;
  baseTransform?: SceneTransform;
  transform?: SceneTransform;
  rigidTransform?: boolean;
  deleted?: boolean;
  geometryBounds?: {
    min: Vector3;
    max: Vector3;
    unit: "m";
    space: "object-local";
  };
  cylinderCandidates?: CylinderCandidate[];
};
export type WorldBounds = {
  min: Vector3;
  max: Vector3;
  size: Vector3;
  unit: "m";
  space: "world-z-up";
  accuracy: "conservative";
};

// 前端在加载 glTF 后用 +90° X 外层旋转抵消 glTF 文件内的 Y-up 转换。
const basis: Quaternion = [0, 0, 0, 1];

function normalized(rotation: Quaternion): Quaternion {
  if (!Array.isArray(rotation) || rotation.length !== 4 || !rotation.every(Number.isFinite))
    throw new Error("对象旋转无效。");
  const norm = Math.hypot(...rotation);
  if (norm < 1e-12) throw new Error("对象旋转无效。");
  return rotation.map((value) => value / norm) as Quaternion;
}

function multiply(a: Quaternion, b: Quaternion): Quaternion {
  return normalized([
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]);
}

function rotate(point: Vector3, q: Quaternion): Vector3 {
  const [x, y, z, w] = q;
  const [px, py, pz] = point;
  const u: Vector3 = [y * pz - z * py, z * px - x * pz, x * py - y * px];
  const v: Vector3 = [y * u[2] - z * u[1], z * u[0] - x * u[2], x * u[1] - y * u[0]];
  return [px + 2 * (w * u[0] + v[0]), py + 2 * (w * u[1] + v[1]), pz + 2 * (w * u[2] + v[2])];
}

function add(a: Vector3, b: Vector3): Vector3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function pose(object: SceneObject): SceneTransform {
  if (object.deleted) throw new Error("对象或其父对象已删除。");
  if (object.rigidTransform !== true)
    throw new Error("对象或祖先包含缩放或缺少刚体变换信息，不能计算世界边界。");
  const value = object.transform ?? object.baseTransform;
  if (value?.position?.length !== 3 || !value.position.every(Number.isFinite))
    throw new Error("对象位置缺失或无效。");
  return { position: value.position, rotation: normalized(value.rotation) };
}

function chain(objects: readonly SceneObject[], objectId: string): SceneObject[] {
  const byId = new Map<string, SceneObject>();
  for (const object of objects) {
    if (byId.has(object.id)) throw new Error("场景对象 ID 重复。");
    byId.set(object.id, object);
  }

  const result: SceneObject[] = [];
  const visited = new Set<string>();
  let id: string | null = objectId;
  while (id !== null) {
    if (visited.has(id) || result.length >= 256)
      throw new Error("场景对象层级循环或超过深度限制。");
    const object = byId.get(id);
    if (!object) throw new Error("场景对象或其父对象不存在。");
    visited.add(id);
    result.push(object);
    id = object.parentId;
  }

  result.reverse();
  return result;
}

function worldPose(objects: readonly SceneObject[]): SceneTransform {
  let position: Vector3 = [0, 0, 0];
  let rotation = basis;
  for (const object of objects) {
    const local = pose(object);
    position = add(position, rotate(local.position, rotation));
    rotation = multiply(rotation, local.rotation);
  }
  return { position, rotation };
}

/** 查询对象当前 Z-up 世界刚体位姿；缺失、删除或缩放父链会被拒绝。 */
export function getObjectWorldTransform(
  objects: readonly SceneObject[],
  objectId: string,
): SceneTransform {
  return worldPose(chain(objects, objectId));
}

export function getWorldBounds(objects: readonly SceneObject[], objectId: string): WorldBounds {
  const parents = chain(objects, objectId);
  const object = parents[parents.length - 1];
  if (!object) throw new Error("场景对象不存在。");
  const bounds = object.geometryBounds;
  if (bounds?.unit !== "m" || bounds.space !== "object-local")
    throw new Error("对象没有可用的局部几何边界；装配容器暂不支持该操作。");

  if (
    !Array.isArray(bounds.min) ||
    !Array.isArray(bounds.max) ||
    bounds.min.length !== 3 ||
    bounds.max.length !== 3 ||
    ![...bounds.min, ...bounds.max].every(Number.isFinite) ||
    ([0, 1, 2] as const).some((index) => bounds.min[index] > bounds.max[index])
  )
    throw new Error("对象局部几何边界无效。");

  const world = worldPose(parents);
  const min: Vector3 = [Infinity, Infinity, Infinity];
  const max: Vector3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]])
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const point = add(world.position, rotate([x, y, z], world.rotation));
        for (const axis of [0, 1, 2] as const) {
          min[axis] = Math.min(min[axis], point[axis]);
          max[axis] = Math.max(max[axis], point[axis]);
        }
      }

  const size: Vector3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (![...min, ...max, ...size].every(Number.isFinite)) throw new Error("世界边界数值溢出。");
  return {
    min,
    max,
    size,
    unit: "m",
    space: "world-z-up",
    accuracy: "conservative",
  };
}

/** 将世界包围盒最小角移到世界原点；不改变对象局部旋转。 */
export function alignBoundsToOrigin(
  objects: readonly SceneObject[],
  objectId: string,
): SceneTransform {
  const parents = chain(objects, objectId);
  const object = parents[parents.length - 1];
  if (!object) throw new Error("场景对象不存在。");
  const current = object.transform ?? object.baseTransform;
  if (!current) throw new Error("对象变换缺失。");

  const bounds = getWorldBounds(objects, objectId);
  const parentRotation = worldPose(parents.slice(0, -1)).rotation;
  const inverse: Quaternion = [
    -parentRotation[0],
    -parentRotation[1],
    -parentRotation[2],
    parentRotation[3],
  ];

  const localDelta = rotate([-bounds.min[0], -bounds.min[1], -bounds.min[2]], inverse);
  const position = add(current.position, localDelta);
  if (!position.every(Number.isFinite)) throw new Error("对齐位置数值溢出。");
  return { position, rotation: [...current.rotation] };
}

type CylinderSelection = {
  modelId: string;
  objects: readonly SceneObject[];
  objectId: string;
  faceIndex: number;
};
type WorldAxis = { origin: Vector3; direction: Vector3; radiusM: number };

function worldCylinder(selection: CylinderSelection): WorldAxis {
  if (!Number.isSafeInteger(selection.faceIndex) || selection.faceIndex < 1)
    throw new Error("圆柱面编号无效。");
  const parents = chain(selection.objects, selection.objectId);
  const object = parents[parents.length - 1];
  if (!object) throw new Error("场景对象不存在。");

  const matches =
    object.cylinderCandidates?.filter((candidate) => candidate.faceIndex === selection.faceIndex) ??
    [];
  if (matches.length !== 1) throw new Error("圆柱面候选不存在或编号不唯一。");
  const candidate = matches[0];
  if (
    candidate?.unit !== "m" ||
    candidate.space !== "object-local" ||
    candidate.evidence !== "analytic-cylinder" ||
    candidate.kinematics !== "unknown" ||
    !Array.isArray(candidate.axisOrigin) ||
    candidate.axisOrigin.length !== 3 ||
    !Array.isArray(candidate.axisDirection) ||
    candidate.axisDirection.length !== 3 ||
    ![...candidate.axisOrigin, ...candidate.axisDirection, candidate.radius].every(
      Number.isFinite,
    ) ||
    candidate.radius <= 0
  )
    throw new Error("圆柱面几何证据无效。");

  const length = Math.hypot(...candidate.axisDirection);
  if (!Number.isFinite(length) || length < 1e-12) throw new Error("圆柱轴方向无效。");
  const localDirection: Vector3 = [
    candidate.axisDirection[0] / length,
    candidate.axisDirection[1] / length,
    candidate.axisDirection[2] / length,
  ];

  const world = worldPose(parents);
  const origin = add(world.position, rotate(candidate.axisOrigin, world.rotation));
  const direction = rotate(localDirection, world.rotation);
  if (![...origin, ...direction].every(Number.isFinite)) throw new Error("世界轴线数值溢出。");
  return { origin, direction, radiusM: candidate.radius };
}

/** 比较无限轴线的几何误差；结果不推断连接或关节。 */
export function compareCylinderAxes(
  first: CylinderSelection,
  second: CylinderSelection,
  tolerance: { angleRad: number; distanceM: number },
) {
  if (!first.modelId || !second.modelId) throw new Error("场景模型标识无效。");
  if (first.modelId === second.modelId && first.objectId === second.objectId)
    throw new Error("请选择两个不同对象。");
  if (
    !Number.isFinite(tolerance.angleRad) ||
    tolerance.angleRad < 0 ||
    tolerance.angleRad > Math.PI / 2 ||
    !Number.isFinite(tolerance.distanceM) ||
    tolerance.distanceM < 0
  )
    throw new Error("轴线比较容差无效。");

  const a = worldCylinder(first);
  const b = worldCylinder(second);
  const cross: Vector3 = [
    a.direction[1] * b.direction[2] - a.direction[2] * b.direction[1],
    a.direction[2] * b.direction[0] - a.direction[0] * b.direction[2],
    a.direction[0] * b.direction[1] - a.direction[1] * b.direction[0],
  ];
  const dot =
    a.direction[0] * b.direction[0] +
    a.direction[1] * b.direction[1] +
    a.direction[2] * b.direction[2];
  const angleRad = Math.atan2(Math.hypot(...cross), Math.abs(dot));
  const displacement: Vector3 = [
    b.origin[0] - a.origin[0],
    b.origin[1] - a.origin[1],
    b.origin[2] - a.origin[2],
  ];
  // 第二轴的参考点到第一条无限轴线的垂直距离，非有限曲面间的最短距离。
  const offset: Vector3 = [
    displacement[1] * a.direction[2] - displacement[2] * a.direction[1],
    displacement[2] * a.direction[0] - displacement[0] * a.direction[2],
    displacement[0] * a.direction[1] - displacement[1] * a.direction[0],
  ];
  const axisOffsetM = Math.hypot(...offset);
  const radiusDifferenceM = Math.abs(a.radiusM - b.radiusM);
  if (![angleRad, axisOffsetM, radiusDifferenceM].every(Number.isFinite))
    throw new Error("轴线比较数值溢出。");
  return {
    first: a,
    second: b,
    angleRad,
    axisOffsetM,
    radiusDifferenceM,
    tolerance: { ...tolerance },
    withinTolerance: angleRad <= tolerance.angleRad && axisOffsetM <= tolerance.distanceM,
    space: "world-z-up" as const,
    offsetDefinition: "second-origin-to-first-infinite-axis" as const,
    connection: "unverified" as const,
    jointType: "unknown" as const,
    jointLimits: "unknown" as const,
  };
}
