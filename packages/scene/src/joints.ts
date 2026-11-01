/** 关节候选是项目场景数据；纯函数不调用模型、不确认实际机械连接。 */
export type JointObjectRef = { modelId: string; objectId: string };
export type JointAxis = {
  origin: [number, number, number];
  direction: [number, number, number];
  unit: "m";
  space: "parent-local";
};
export type JointScene = {
  revision: number;
  models: readonly {
    id: string;
    objects: readonly { id: string; parentId: string | null; deleted?: boolean }[];
  }[];
};
export type JointDraftInput = {
  id: string;
  parent: JointObjectRef;
  child: JointObjectRef;
  type: "fixed" | "revolute" | "prismatic";
  axis?: JointAxis;
  evidenceRevision: number;
};
export type JointCandidate = JointDraftInput & {
  status: "draft" | "confirmed";
  validity: "current" | "stale" | "invalidated";
  limits: "unknown";
};

function key(ref: JointObjectRef): string {
  if (
    typeof ref?.modelId !== "string" ||
    !ref.modelId ||
    typeof ref.objectId !== "string" ||
    !ref.objectId
  )
    throw new Error("关节对象引用无效。");
  return JSON.stringify([ref.modelId, ref.objectId]);
}

/** 返回对象和祖先；模型替换、对象删除时返回 null，结构损坏时拒绝。 */
function ancestry(scene: JointScene, ref: JointObjectRef): JointObjectRef[] | null {
  key(ref);
  const models = scene.models.filter((model) => model.id === ref.modelId);
  if (models.length > 1) throw new Error("场景模型 ID 重复。");
  const model = models[0];
  if (!model) return null;

  const objects = new Map<string, (typeof model.objects)[number]>();
  for (const object of model.objects) {
    if (objects.has(object.id)) throw new Error("场景对象 ID 重复。");
    objects.set(object.id, object);
  }

  const chain: JointObjectRef[] = [];
  const visited = new Set<string>();
  let id: string | null = ref.objectId;
  while (id !== null) {
    if (visited.has(id) || chain.length >= 256) throw new Error("场景对象层级循环或过深。");
    const object = objects.get(id);
    if (!object || object.deleted) return null;
    visited.add(id);
    chain.push({ modelId: ref.modelId, objectId: id });
    id = object.parentId;
  }

  return chain;
}

function requireAvailable(scene: JointScene, ref: JointObjectRef): void {
  if (!ancestry(scene, ref)) throw new Error("场景对象或其祖先不存在或已删除。");
}

function validateAxis(type: JointDraftInput["type"], axis?: JointAxis): void {
  if (type !== "fixed" && !axis) throw new Error("旋转或移动关节必须提供轴线。");
  if (!axis) return;
  if (
    axis.unit !== "m" ||
    axis.space !== "parent-local" ||
    !Array.isArray(axis.origin) ||
    !Array.isArray(axis.direction) ||
    axis.origin.length !== 3 ||
    axis.direction.length !== 3 ||
    ![...axis.origin, ...axis.direction].every(Number.isFinite)
  )
    throw new Error("关节轴线无效。");
  if (Math.abs(Math.hypot(...axis.direction) - 1) > 1e-6)
    throw new Error("关节轴方向必须为单位向量。");
}

function validateGraph(
  input: JointDraftInput,
  existing: readonly JointCandidate[],
  excludeId?: string,
): void {
  const ids = new Set<string>();
  const parents = new Map<string, string>();
  for (const candidate of existing) {
    if (ids.has(candidate.id)) throw new Error("关节候选 ID 重复。");
    ids.add(candidate.id);
    if (candidate.id === excludeId || candidate.validity === "invalidated") continue;
    const parent = key(candidate.parent);
    const child = key(candidate.child);
    if (parents.has(child)) throw new Error("对象已有父节点关节。");
    parents.set(child, parent);
  }

  if (ids.has(input.id) && input.id !== excludeId) throw new Error("关节候选 ID 重复。");
  const parent = key(input.parent);
  const child = key(input.child);
  if (parent === child) throw new Error("关节需要两个不同对象。");
  if (parents.has(child)) throw new Error("对象已有父节点关节。");
  parents.set(child, parent);

  const complete = new Set<string>();
  for (const start of parents.keys()) {
    const seen = new Set<string>();
    const path: string[] = [];
    let current: string | undefined = start;
    while (current !== undefined && !complete.has(current)) {
      if (seen.has(current)) throw new Error("关节关系形成循环。");
      seen.add(current);
      path.push(current);
      current = parents.get(current);
    }
    for (const item of path) complete.add(item);
  }
}

function validateInput(
  input: JointDraftInput,
  scene: JointScene,
  existing: readonly JointCandidate[],
  excludeId?: string,
): void {
  if (!input.id || input.id.length > 200) throw new Error("关节候选 ID 无效。");
  if (!["fixed", "revolute", "prismatic"].includes(input.type)) throw new Error("关节类型无效。");
  requireAvailable(scene, input.parent);
  requireAvailable(scene, input.child);
  validateAxis(input.type, input.axis);
  validateGraph(input, existing, excludeId);
}

export function createJointDraft(
  input: JointDraftInput,
  scene: JointScene,
  existing: readonly JointCandidate[],
): JointCandidate {
  if (
    !Number.isSafeInteger(scene.revision) ||
    scene.revision < 0 ||
    !Number.isSafeInteger(input.evidenceRevision) ||
    input.evidenceRevision !== scene.revision
  )
    throw new Error("候选证据版本已过期，请重新读取场景。");

  validateInput(input, scene, existing);
  return {
    ...input,
    parent: { ...input.parent },
    child: { ...input.child },
    ...(input.axis
      ? {
          axis: {
            ...input.axis,
            origin: [...input.axis.origin],
            direction: [...input.axis.direction],
          },
        }
      : {}),
    status: "draft",
    validity: "current",
    limits: "unknown",
  };
}

/** 调用方必须从可信的用户确认入口调用；字面量本身不是身份认证。 */
export function confirmJointDraft(
  candidateId: string,
  scene: JointScene,
  existing: readonly JointCandidate[],
  expectedRevision: number,
  confirmation: "explicit-user",
): JointCandidate {
  if (confirmation !== "explicit-user") throw new Error("需要用户明确确认。");
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision !== scene.revision
  )
    throw new Error("场景版本已变化。");

  const candidates = existing.filter((item) => item.id === candidateId);
  if (candidates.length !== 1 || !candidates[0]) throw new Error("关节候选不存在或 ID 重复。");
  const candidate = candidates[0];
  if (candidate.status !== "draft") throw new Error("关节候选不是待确认草稿。");
  if (candidate.validity !== "current") throw new Error("关节候选证据已过期或失效。");

  validateInput(candidate, scene, existing, candidate.id);
  return { ...candidate, status: "confirmed" };
}

/** 变换前后由调用方传入实际受影响对象；删除/替换可从快照直接判失效。 */
export function reconcileJointCandidates(
  candidates: readonly JointCandidate[],
  scene: JointScene,
  changed: readonly JointObjectRef[],
): JointCandidate[] {
  const changedKeys = new Set(changed.map(key));
  return candidates.map((candidate) => {
    if (candidate.validity === "invalidated") return candidate;
    const parent = ancestry(scene, candidate.parent);
    const child = ancestry(scene, candidate.child);
    if (!parent || !child) return { ...candidate, validity: "invalidated" };
    if ([...parent, ...child].some((ref) => changedKeys.has(key(ref))))
      return candidate.validity === "stale" ? candidate : { ...candidate, validity: "stale" };
    return candidate;
  });
}
