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
import { coordinates, robotFrames } from "../../shared/scene/frames.ts";
import { sourcePartIds } from "../../shared/scene/geometry.ts";
import { transparencyKey, transparencyTargets } from "../../shared/scene/transparency.ts";
import { subtreeLinkIds } from "../../shared/scene/tree.ts";

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
  const sources = new Map(document.sourceRobot?.links.map((link) => [link.id, link]));
  const assigned = new Set<string>();
  for (const link of document.robot?.links ?? []) {
    for (const part of link.sourceParts ?? []) {
      if (!sources.get(part.sourceId)?.visuals.length)
        throw new Error("绑定的原始零件不存在或没有几何。");
      if (assigned.has(part.sourceId)) throw new Error("原始零件只能属于一个 Link。");
      assigned.add(part.sourceId);
    }
  }
  const settings = new Set<string>();
  for (const setting of document.transparencies ?? []) {
    const links = setting.entity === "source" ? document.sourceRobot?.links : document.robot?.links;
    if (!links?.some((link) => link.id === setting.id)) throw new Error("透明度引用的对象不存在。");
    const key = transparencyKey(setting);
    if (settings.has(key)) throw new Error("对象透明度设置重复。");
    settings.add(key);
  }
  if (document.sourceRobot?.links.some((link) => link.sourceParts?.length))
    throw new Error("原始模型不能引用其他原始零件。");
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

type RobotOperation = Exclude<
  SceneOperation,
  { op: "undo" | "assignSource" | "createSourceLink" | "unassignSource" | "setTransparency" }
>;

function editRobot(robot: SceneRobot, operation: RobotOperation) {
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
    case "updateJoint": {
      const joint = findJoint(operation.jointId);
      findLink(operation.parentId);
      const { jointType, limit } = operation;
      // 直线关节与旋转关节的预览位置单位不同，切换时从零开始。
      const sameUnit = (joint.type === "prismatic") === (jointType === "prismatic");
      const position = sameUnit ? joint.position : 0;
      const updated: SceneJoint = {
        ...joint,
        name: operation.name.trim(),
        parentId: operation.parentId,
        type: jointType,
        origin: operation.origin,
        axis: operation.axis,
        position:
          jointType === "fixed"
            ? 0
            : Math.min(limit?.upper ?? Infinity, Math.max(limit?.lower ?? -Infinity, position)),
      };
      delete updated.limit;
      if (limit) updated.limit = limit;
      if (Value.Equal(updated, joint)) return robot;
      next.joints[next.joints.indexOf(joint)] = updated;
      break;
    }
    case "removeSubtree": {
      findLink(operation.linkId);
      if (operation.linkId === next.rootLinkId) throw new Error("不能删除根 Link。");
      const removed = subtreeLinkIds(next, [operation.linkId]);
      next.links = next.links.filter((link) => !removed.has(link.id));
      next.joints = next.joints.filter((joint) => !removed.has(joint.childId));
      break;
    }
  }
  return next;
}

export function editScene(
  document: SceneDocument,
  operation: Exclude<SceneOperation, { op: "undo" }>,
): SceneDocument {
  if (operation.op === "setTransparency") {
    const targets = transparencyTargets(document, operation.entity, operation.ids);
    if (!targets.length) throw new Error("所选对象没有可显示的几何。");
    const settings = new Map(
      document.transparencies?.map((setting) => [transparencyKey(setting), setting]),
    );
    if (
      targets.every(
        (target) => (settings.get(transparencyKey(target))?.value ?? 0) === operation.value,
      )
    )
      return document;
    for (const target of targets) {
      const key = transparencyKey(target);
      if (operation.value === 0) settings.delete(key);
      else settings.set(key, { ...target, value: operation.value });
    }
    return { ...document, transparencies: [...settings.values()] };
  }
  let robot = document.robot;
  if (!robot) throw new Error("请先导入场景。");
  if (
    operation.op !== "assignSource" &&
    operation.op !== "createSourceLink" &&
    operation.op !== "unassignSource"
  ) {
    const next = editRobot(robot, operation);
    if (next === robot) return document;
    if (operation.op !== "removeSubtree" || !document.transparencies)
      return { ...document, robot: next };
    return {
      ...document,
      robot: next,
      transparencies: document.transparencies.filter(
        (setting) =>
          setting.entity === "source" || next.links.some((link) => link.id === setting.id),
      ),
    };
  }
  const source = document.sourceRobot;
  if (!source) throw new Error("请先导入原始模型。");
  const ids = sourcePartIds(source, operation.sourceIds);
  if (!ids.length) throw new Error("所选对象中没有可配置的零件几何。");
  const selected = new Set(ids);
  if (operation.op === "unassignSource") {
    let changed = false;
    const links = robot.links.map((link) => {
      if (!link.sourceParts?.length) return link;
      const parts = link.sourceParts.filter((part) => !selected.has(part.sourceId));
      if (parts.length === link.sourceParts.length) return link;
      changed = true;
      return { ...link, sourceParts: parts };
    });
    return changed ? { ...document, robot: { ...robot, links } } : document;
  }
  const sourceFrames = robotFrames(source);
  sourceFrames.root.updateMatrixWorld(true);
  let targetId: string;
  if (operation.op === "createSourceLink") {
    robot = editRobot(robot, { ...operation, op: "addChildLink" });
    const child = robot.links.at(-1);
    const joint = robot.joints.at(-1);
    if (!child || !joint) throw new Error("创建 Link 失败。");
    targetId = child.id;
    const frames = robotFrames(robot);
    frames.root.updateMatrixWorld(true);
    const parent = frames.links.get(operation.parentId);
    const first = sourceFrames.links.get(ids[0] ?? "");
    if (!parent || !first) throw new Error("零件坐标不存在。");
    joint.origin = coordinates(parent.matrixWorld.clone().invert().multiply(first.matrixWorld));
  } else {
    targetId = operation.linkId;
    const link = robot.links.find((link) => link.id === targetId);
    if (!link) throw new Error("Link 不存在。");
    if (ids.every((id) => link.sourceParts?.some((part) => part.sourceId === id))) return document;
  }
  const frames = robotFrames(robot);
  frames.root.updateMatrixWorld(true);
  const target = frames.links.get(targetId);
  if (!target) throw new Error("Link 坐标不存在。");
  const inverse = target.matrixWorld.clone().invert();
  robot = {
    ...robot,
    links: robot.links.map((link) => {
      const parts = (link.sourceParts ?? []).filter((part) => !selected.has(part.sourceId));
      if (link.id === targetId) {
        for (const sourceId of ids) {
          const frame = sourceFrames.links.get(sourceId);
          if (!frame) throw new Error("零件坐标不存在。");
          parts.push(
            link.sourceParts?.find((part) => part.sourceId === sourceId) ?? {
              sourceId,
              origin: coordinates(inverse.clone().multiply(frame.matrixWorld)),
            },
          );
        }
      }
      return { ...link, sourceParts: parts };
    }),
  };
  return { ...document, robot };
}
