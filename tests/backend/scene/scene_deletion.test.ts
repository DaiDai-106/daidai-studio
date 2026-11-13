import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectStore } from "../../../src/backend/projects/store.ts";
import { createSceneService } from "../../../src/backend/scene/scene_service.ts";

test("删除对象及后代可恢复且不修改 STEP 和 GLB，过期或重复删除被拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "dai-scene-delete-"));
  const dataRoot = join(root, "data");
  const source = join(root, "source.step");
  const glb = join(root, "scene.glb");
  writeFileSync(source, "STEP source");
  writeFileSync(glb, "glTF data");
  let store = openProjectStore(dataRoot);
  let scenes = createSceneService({ dataRoot, store });
  try {
    const project = store.createProject({ name: "场景", mode: "scene", path: root });
    const hash = "a".repeat(64);
    store.saveScene(project.id, 0, {
      models: [
        {
          source: { path: source, sha256: hash },
          resource: { path: glb, format: "glb", byteLength: 9, sha256: hash },
          objects: [
            { id: "root", name: "根", parentId: null },
            { id: "arm", name: "手臂", parentId: "root" },
            { id: "tool", name: "工具", parentId: "arm" },
            { id: "other", name: "其他", parentId: "root" },
          ],
          warnings: [],
          complete: false,
        },
      ],
    });
    const initial = scenes.get(project.id);
    const model = initial.models[0];
    assert.ok(model);
    const updated = scenes.deleteObject({
      projectId: project.id,
      modelId: model.id,
      objectId: "arm",
      revision: 1,
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.models[0]?.objects.find((item) => item.id === "arm")?.deleted, true);
    assert.equal(updated.models[0]?.objects.find((item) => item.id === "tool")?.deleted, true);
    assert.equal(
      updated.models[0]?.objects.find((item) => item.id === "other")?.deleted,
      undefined,
    );
    assert.throws(
      () =>
        scenes.deleteObject({
          projectId: project.id,
          modelId: model.id,
          objectId: "other",
          revision: 1,
        }),
      /其他会话更新/,
    );
    assert.throws(
      () =>
        scenes.deleteObject({
          projectId: project.id,
          modelId: model.id,
          objectId: "arm",
          revision: 2,
        }),
      /已删除/,
    );
    assert.throws(
      () =>
        scenes.setTransform({
          projectId: project.id,
          modelId: model.id,
          objectId: "tool",
          revision: 2,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
        }),
      /已删除/,
    );
    assert.equal(readFileSync(source, "utf8"), "STEP source");
    assert.equal(readFileSync(glb, "utf8"), "glTF data");
    await scenes.dispose();
    store.close();
    store = openProjectStore(dataRoot);
    scenes = createSceneService({ dataRoot, store });
    assert.deepEqual(scenes.get(project.id), updated);
  } finally {
    await scenes.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
