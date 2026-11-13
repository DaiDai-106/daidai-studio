import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confirmJointDraft,
  createJointDraft,
  type JointDraftInput,
  type JointScene,
  reconcileJointCandidates,
} from "../../packages/scene/src/joints.ts";

const scene: JointScene = {
  revision: 7,
  models: [
    {
      id: "m1",
      objects: [
        { id: "root", parentId: null },
        { id: "parent", parentId: "root" },
        { id: "child", parentId: "root" },
        { id: "third", parentId: null },
      ],
    },
    {
      id: "m2",
      objects: [
        { id: "parent", parentId: null },
        { id: "other", parentId: null },
      ],
    },
  ],
};
const parent = { modelId: "m1", objectId: "parent" };
const child = { modelId: "m1", objectId: "child" };
const axis = {
  origin: [0, 0, 0] as [number, number, number],
  direction: [0, 0, 1] as [number, number, number],
  unit: "m" as const,
  space: "parent-local" as const,
};
const draftInput: JointDraftInput = {
  id: "joint-1",
  parent,
  child,
  type: "revolute",
  axis,
  evidenceRevision: 7,
};

test("draft 仅保存显式选择的对象、类型和单位轴，限位未知并要求新鲜证据", () => {
  const joint = createJointDraft(draftInput, scene, []);
  assert.equal(joint.status, "draft");
  assert.equal(joint.validity, "current");
  assert.equal(joint.limits, "unknown");
  assert.deepEqual(joint.axis, axis);
  assert.throws(
    () => createJointDraft({ ...draftInput, evidenceRevision: 6 }, scene, []),
    /版本|证据/,
  );
  assert.throws(() => createJointDraft({ ...draftInput, child: parent }, scene, []), /不同对象/);
  assert.throws(
    () =>
      createJointDraft(
        { ...draftInput, child: { modelId: "missing", objectId: "child" } },
        scene,
        [],
      ),
    /不存在/,
  );
  const { axis: _axis, ...withoutAxis } = draftInput;
  assert.throws(() => createJointDraft({ ...withoutAxis, type: "prismatic" }, scene, []), /轴/);
  assert.throws(
    () => createJointDraft({ ...draftInput, axis: { ...axis, direction: [0, 0, 2] } }, scene, []),
    /单位|轴/,
  );
  assert.throws(
    () => createJointDraft({ ...draftInput, axis: { ...axis, origin: [NaN, 0, 0] } }, scene, []),
    /无效|轴/,
  );
  const fixed = createJointDraft(
    { id: "fixed", parent, child, type: "fixed", evidenceRevision: 7 },
    scene,
    [],
  );
  assert.equal(fixed.axis, undefined);
  const crossModel = createJointDraft(
    { ...draftInput, id: "cross", child: { modelId: "m2", objectId: "parent" } },
    scene,
    [],
  );
  assert.equal(crossModel.child.modelId, "m2");
});

test("关节图拒绝重复父节点和环，区分不同模型内同名对象", () => {
  const first = createJointDraft(draftInput, scene, []);
  assert.throws(
    () =>
      createJointDraft(
        { ...draftInput, id: "duplicate", parent: { modelId: "m1", objectId: "third" } },
        scene,
        [first],
      ),
    /父节点/,
  );
  assert.throws(
    () =>
      createJointDraft({ ...draftInput, id: "cycle", parent: child, child: parent }, scene, [
        first,
      ]),
    /循环|环/,
  );
  const cross = createJointDraft(
    { ...draftInput, id: "cross", parent: child, child: { modelId: "m2", objectId: "parent" } },
    scene,
    [first],
  );
  assert.equal(cross.child.modelId, "m2");
  assert.throws(
    () =>
      createJointDraft(
        { ...draftInput, id: "joint-1", child: { modelId: "m1", objectId: "third" } },
        scene,
        [first],
      ),
    /重复/,
  );
});

test("确认必须是用户操作和当前 revision，stale 或 invalidated 不可确认", () => {
  const joint = createJointDraft(draftInput, scene, []);
  const latest = { ...scene, revision: 8 };
  assert.throws(() => confirmJointDraft(joint.id, latest, [joint], 7, "explicit-user"), /版本/);
  assert.throws(
    () =>
      confirmJointDraft(joint.id, latest, [{ ...joint, validity: "stale" }], 8, "explicit-user"),
    /过期/,
  );
  assert.throws(() => confirmJointDraft("missing", latest, [joint], 8, "explicit-user"), /不存在/);
  assert.throws(
    () => confirmJointDraft(joint.id, latest, [joint], 8, "not-user" as "explicit-user"),
    /用户/,
  );
  const confirmed = confirmJointDraft(joint.id, latest, [joint], 8, "explicit-user");
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.limits, "unknown");
  assert.equal(joint.status, "draft");
});

test("对象及祖先变换使证据 stale，删除或替换使关联 invalidated，其他模型不受影响", () => {
  const joint = createJointDraft(draftInput, scene, []);
  const other = createJointDraft(
    {
      id: "joint-2",
      parent: { modelId: "m2", objectId: "parent" },
      child: { modelId: "m2", objectId: "other" },
      type: "fixed",
      evidenceRevision: 7,
    },
    scene,
    [joint],
  );
  const unchanged = reconcileJointCandidates([joint, other], scene, [
    { modelId: "m1", objectId: "third" },
  ]);
  assert.equal(unchanged[0]?.validity, "current");
  const changed = reconcileJointCandidates([joint, other], scene, [
    { modelId: "m1", objectId: "root" },
  ]);
  assert.equal(changed[0]?.validity, "stale");
  assert.equal(changed[1]?.validity, "current");
  const removed: JointScene = {
    ...scene,
    revision: 8,
    models: scene.models.map((model) =>
      model.id === "m1"
        ? {
            ...model,
            objects: model.objects.map((item) =>
              item.id === "root" ? { ...item, deleted: true } : item,
            ),
          }
        : model,
    ),
  };
  const invalid = reconcileJointCandidates([joint, other], removed, [
    { modelId: "m1", objectId: "root" },
  ]);
  assert.equal(invalid[0]?.validity, "invalidated");
  assert.equal(invalid[1]?.validity, "current");
  const replacement: JointScene = {
    revision: 8,
    models: scene.models.filter((model) => model.id !== "m1"),
  };
  assert.equal(reconcileJointCandidates([joint], replacement, [])[0]?.validity, "invalidated");
  assert.equal(joint.validity, "current");
});
