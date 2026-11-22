import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
  type SceneDocument,
  SceneDocumentSchema,
  type SceneJoint,
  type SceneOperation,
  type SceneOrigin,
  type SceneRobot,
} from "../../contracts/scene.ts";

export const zeroOrigin = (): SceneOrigin => ({ xyz: [0, 0, 0], rpy: [0, 0, 0] });

export function jointPosition(joint: SceneJoint, position: number) {
  if (!Number.isFinite(position)) throw new Error("关节位置必须是有限数字。");
  if (joint.type === "fixed" && position !== 0) throw new Error("固定关节不能移动。");
  const { lower, upper } = joint.limit ?? {};
  if ((lower !== undefined && position < lower) || (upper !== undefined && position > upper))
    throw new Error("关节位置超出限位。");
  return position;
}

export function validateScene(document: unknown): asserts document is SceneDocument {
  if (!Value.Check(SceneDocumentSchema, document)) throw new Error("场景文档格式无效。");
  if (document.robot) validateRobot(document.robot);
  if (document.sourceRobot && document.sourceRobot !== document.robot)
    validateRobot(document.sourceRobot);
}

function validateRobot(robot: SceneRobot) {
  for (const name of [
    robot.name,
    ...robot.links.map((link) => link.name),
    ...robot.joints.map((joint) => joint.name),
  ]) {
    if (!name.trim() || /\p{Cc}/u.test(name)) throw new Error("机器人、Link 或 Joint 的名称无效。");
  }
  const links = new Set(robot.links.map((link) => link.id));
  const joints = new Set(robot.joints.map((joint) => joint.id));
  if (
    links.size !== robot.links.length ||
    joints.size !== robot.joints.length ||
    robot.joints.some((joint) => links.has(joint.id)) ||
    new Set(robot.links.map((link) => link.name)).size !== links.size ||
    new Set(robot.joints.map((joint) => joint.name)).size !== joints.size
  )
    throw new Error("Link 或 Joint 的 ID 或名称重复。");
  const parents = new Map<string, string>();
  for (const joint of robot.joints) {
    if (!links.has(joint.parentId) || !links.has(joint.childId))
      throw new Error("关节引用了不存在的 Link。");
    if (parents.has(joint.childId)) throw new Error("一个 Link 只能有一个父关节。");
    parents.set(joint.childId, joint.parentId);
    if (joint.type !== "fixed" && Math.hypot(...joint.axis) < 1e-12)
      throw new Error("活动关节的轴向不能为零。");
    const { lower, upper } = joint.limit ?? {};
    const bounded = joint.type === "revolute" || joint.type === "prismatic";
    if (
      bounded !== (lower !== undefined) ||
      bounded !== (upper !== undefined) ||
      (joint.type === "fixed" && joint.limit)
    )
      throw new Error("关节类型与限位不匹配。");
    if (lower !== undefined && upper !== undefined && lower > upper)
      throw new Error("关节限位颠倒。");
    jointPosition(joint, joint.position);
  }
  if (
    !links.has(robot.rootLinkId) ||
    parents.has(robot.rootLinkId) ||
    parents.size !== links.size - 1
  )
    throw new Error("机器人必须是一棵单根树。");
  const reachable = new Set([robot.rootLinkId]);
  for (const link of links) {
    const path = new Set<string>();
    let current = link;
    while (!reachable.has(current)) {
      if (path.has(current)) throw new Error("关节拓扑存在循环。");
      path.add(current);
      const parent = parents.get(current);
      if (!parent) throw new Error("Link 没有连接到根节点。");
      current = parent;
    }
    for (const id of path) reachable.add(id);
  }
}

export function editRobot(robot: SceneRobot, operation: Exclude<SceneOperation, { op: "undo" }>) {
  if (operation.op === "setJointPosition") {
    const joint = robot.joints.find(({ id }) => id === operation.jointId);
    if (!joint) throw new Error("关节不存在。");
    const position = jointPosition(joint, operation.position);
    return position === joint.position
      ? robot
      : {
          ...robot,
          joints: robot.joints.map((item) => (item === joint ? { ...item, position } : item)),
        };
  }
  const next = { ...robot, links: [...robot.links], joints: [...robot.joints] };
  const findLink = (id: string) => {
    const link = next.links.find((link) => link.id === id);
    if (!link) throw new Error("Link 不存在。");
    return link;
  };
  const findJoint = (id: string) => {
    const joint = next.joints.find((joint) => joint.id === id);
    if (!joint) throw new Error("关节不存在。");
    return joint;
  };
  switch (operation.op) {
    case "rename": {
      const name = operation.name.trim();
      if (operation.entity === "link") {
        const link = findLink(operation.id);
        if (link.name === name) return robot;
        next.links[next.links.indexOf(link)] = { ...link, name };
      } else {
        const joint = findJoint(operation.id);
        if (joint.name === name) return robot;
        next.joints[next.joints.indexOf(joint)] = { ...joint, name };
      }
      break;
    }
    case "addChildLink": {
      const parent = findLink(operation.parentId);
      const childId = randomUUID();
      const { jointType, jointName, linkName } = operation;
      next.links.push({ id: childId, name: linkName.trim(), visuals: [] });
      next.joints.push({
        id: randomUUID(),
        name: jointName.trim(),
        type: jointType,
        parentId: parent.id,
        childId,
        origin: zeroOrigin(),
        axis: [0, 0, 1],
        position: 0,
        ...(jointType === "revolute" || jointType === "prismatic"
          ? { limit: { lower: -1, upper: 1, effort: 0, velocity: 0 } }
          : {}),
      });
      break;
    }
    case "removeSubtree": {
      findLink(operation.linkId);
      if (operation.linkId === next.rootLinkId) throw new Error("不能删除根 Link。");
      const removed = new Set([operation.linkId]);
      const children = Map.groupBy(next.joints, (joint) => joint.parentId);
      for (const id of removed) {
        for (const joint of children.get(id) ?? []) removed.add(joint.childId);
      }
      next.links = next.links.filter((link) => !removed.has(link.id));
      next.joints = next.joints.filter((joint) => !removed.has(joint.childId));
      break;
    }
  }
  return next;
}
