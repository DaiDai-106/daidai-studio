import assert from "node:assert/strict";
import { test } from "node:test";
import type { SceneRobot } from "../../../src/contracts/scene.ts";
import { subtreeLinkIds } from "../../../src/shared/scene/tree.ts";

const joint = (parentId: string, childId: string): SceneRobot["joints"][number] => ({
  id: `joint-${childId}`,
  name: `joint-${childId}`,
  parentId,
  childId,
  type: "fixed",
  origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
  axis: [0, 0, 1],
  position: 0,
});

test("子树包含自身与全部后代，多选去重且不包含兄弟节点", () => {
  const robot: SceneRobot = {
    name: "tree",
    rootLinkId: "root",
    links: ["root", "a", "b", "leaf"].map((id) => ({ id, name: id, visuals: [] })),
    joints: [joint("a", "leaf"), joint("root", "b"), joint("root", "a")],
  };
  assert.deepEqual(subtreeLinkIds(robot, []), new Set());
  assert.deepEqual(subtreeLinkIds(robot, ["a"]), new Set(["a", "leaf"]));
  assert.deepEqual(subtreeLinkIds(robot, ["a", "leaf", "a"]), new Set(["a", "leaf"]));
  assert.deepEqual(subtreeLinkIds(robot, ["root"]), new Set(["root", "a", "b", "leaf"]));
  assert.deepEqual(subtreeLinkIds(robot, ["leaf"]), new Set(["leaf"]));
  assert.equal(robot.joints.length, 3);
});
