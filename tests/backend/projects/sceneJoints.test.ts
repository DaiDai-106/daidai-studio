import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSceneService } from "../../../src/backend/projects/sceneService.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";

test("项目关节只能草拟后确认；变换使证据过期，删除使引用失效并持久化", async () => {
  const root = mkdtempSync(join(tmpdir(), "dai-joints-"));
  const dataRoot = join(root, "data");
  let store = openProjectStore(dataRoot);
  let scenes = createSceneService({ dataRoot, store });
  try {
    const project = store.createProject({ name: "A", mode: "scene", path: root });
    const other = store.createProject({ name: "B", mode: "scene", path: root });
    const sha = "a".repeat(64);
    const model = {
      source: { path: join(root, "source.step"), sha256: sha },
      resource: { path: join(root, "source.glb"), sha256: sha, format: "glb", byteLength: 4 },
      objects: [
        { id: "parent", name: "父", parentId: null },
        { id: "child", name: "子", parentId: null },
      ],
      warnings: [],
      complete: false,
    };
    store.saveScene(project.id, 0, { models: [model] });
    store.saveScene(other.id, 0, {
      models: [{ ...model, source: { ...model.source, path: join(root, "other.step") } }],
    });
    const modelId = scenes.get(project.id).models[0]?.id;
    const otherModelId = scenes.get(other.id).models[0]?.id;
    assert.ok(modelId && otherModelId);
    const input = {
      projectId: project.id,
      revision: 1,
      parent: { modelId, objectId: "parent" },
      child: { modelId, objectId: "child" },
      type: "revolute" as const,
      axis: {
        origin: [0, 0, 0] as [number, number, number],
        direction: [0, 0, 1] as [number, number, number],
        unit: "m" as const,
        space: "parent-local" as const,
      },
    };
    assert.throws(
      () =>
        scenes.createJointDraft({ ...input, child: { modelId: otherModelId, objectId: "child" } }),
      /不存在/,
    );
    const draft = scenes.createJointDraft(input);
    const joint = draft.joints[0];
    assert.ok(joint);
    assert.equal(joint.status, "draft");
    assert.equal(joint.limits, "unknown");
    assert.throws(
      () => scenes.confirmJoint({ projectId: project.id, candidateId: joint.id, revision: 1 }),
      /版本/,
    );
    const confirmed = scenes.confirmJoint({
      projectId: project.id,
      candidateId: joint.id,
      revision: draft.revision,
    });
    assert.equal(confirmed.joints[0]?.status, "confirmed");
    const moved = scenes.setTransform({
      projectId: project.id,
      modelId,
      objectId: "parent",
      revision: confirmed.revision,
      transform: { position: [1, 2, 3], rotation: [0, 0, 0, 1] },
    });
    assert.equal(moved.joints[0]?.validity, "stale");
    assert.throws(
      () =>
        scenes.discardJointDraft({
          projectId: project.id,
          candidateId: joint.id,
          revision: moved.revision,
        }),
      /已确认/,
    );
    assert.throws(
      () =>
        scenes.removeConfirmedJoint({
          projectId: project.id,
          candidateId: joint.id,
          revision: confirmed.revision,
        }),
      /版本/,
    );
    const removed = scenes.removeConfirmedJoint({
      projectId: project.id,
      candidateId: joint.id,
      revision: moved.revision,
    });
    assert.deepEqual(removed.joints, []);
    const replacement = scenes.createJointDraft({ ...input, revision: removed.revision });
    const replacementJoint = replacement.joints[0];
    assert.ok(replacementJoint);
    const staleDraft = scenes.setTransform({
      projectId: project.id,
      modelId,
      objectId: "parent",
      revision: replacement.revision,
      transform: { position: [2, 2, 3], rotation: [0, 0, 0, 1] },
    });
    assert.equal(staleDraft.joints[0]?.validity, "stale");
    assert.throws(
      () =>
        scenes.confirmJoint({
          projectId: project.id,
          candidateId: replacementJoint.id,
          revision: staleDraft.revision,
        }),
      /过期|失效/,
    );
    const discarded = scenes.discardJointDraft({
      projectId: project.id,
      candidateId: replacementJoint.id,
      revision: staleDraft.revision,
    });
    assert.deepEqual(discarded.joints, []);
    const fresh = scenes.createJointDraft({ ...input, revision: discarded.revision });
    const freshJoint = fresh.joints[0];
    assert.ok(freshJoint);
    const reconfirmed = scenes.confirmJoint({
      projectId: project.id,
      candidateId: freshJoint.id,
      revision: fresh.revision,
    });
    const deleted = scenes.deleteObject({
      projectId: project.id,
      modelId,
      objectId: "child",
      revision: reconfirmed.revision,
    });
    assert.equal(deleted.joints[0]?.validity, "invalidated");
    await scenes.dispose();
    store.close();
    store = openProjectStore(dataRoot);
    scenes = createSceneService({ dataRoot, store });
    assert.deepEqual(scenes.get(project.id), deleted);
  } finally {
    await scenes.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
