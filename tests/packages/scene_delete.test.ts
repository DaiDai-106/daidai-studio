import assert from "node:assert/strict";
import { test } from "node:test";
import { markDeletedSubtree } from "../../packages/scene/src/objects.ts";
import { getWorldBounds, type SceneObject } from "../../packages/scene/src/world.ts";

test("只删除目标子树，保留其他实例且不修改原数据", () => {
  const objects = [
    { id: "root", parentId: null, name: "assembly" },
    { id: "a", parentId: "root", name: "part" },
    { id: "a-child", parentId: "a", name: "child" },
    { id: "b", parentId: "root", name: "part" },
  ];
  const next = markDeletedSubtree(objects, "a");
  assert.deepEqual(
    next.map((item) => item.deleted === true),
    [false, true, true, false],
  );
  assert.equal(next[2]?.parentId, "a");
  assert.ok(objects.every((item) => !("deleted" in item)));
  assert.throws(() => markDeletedSubtree(next, "a"), /已删除/);
  assert.throws(() => markDeletedSubtree(next, "missing"), /不存在/);
});

test("删除拒绝损坏层级；已删除对象不能再查询边界", () => {
  assert.throws(() => markDeletedSubtree([{ id: "a", parentId: "b" }], "a"), /父对象不存在/);
  assert.throws(
    () =>
      markDeletedSubtree(
        [
          { id: "a", parentId: "b" },
          { id: "b", parentId: "a" },
        ],
        "a",
      ),
    /循环/,
  );
  assert.throws(
    () =>
      markDeletedSubtree(
        [
          { id: "a", parentId: null },
          { id: "a", parentId: null },
        ],
        "a",
      ),
    /重复/,
  );
  const object: SceneObject = {
    id: "part",
    parentId: null,
    rigidTransform: true,
    deleted: true,
    baseTransform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    geometryBounds: { min: [0, 0, 0], max: [1, 2, 3], unit: "m", space: "object-local" },
  };
  assert.throws(() => getWorldBounds([object], "part"), /已删除/);
});
