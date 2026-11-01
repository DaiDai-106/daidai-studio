import { strict as assert } from "node:assert";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createSceneService } from "../../src/backend/projects/sceneService.ts";
import { openProjectStore } from "../../src/backend/projects/store.ts";

test("取消阻塞的距离 worker 不改变已保存场景", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-distance-cancel-"));
  const dataRoot = join(root, "data");
  const store = openProjectStore(dataRoot);
  const scenes = createSceneService({
    dataRoot,
    store,
    pythonExecutable: "python3",
    workerPath: resolve("tests/backend/fixtures/hanging-distance-worker.py"),
  });
  try {
    const project = store.createProject({ name: "场景", mode: "scene", path: root });
    const hash = "a".repeat(64);
    const object = {
      parentId: null,
      sourceKey: "/synthetic",
      rigidTransform: true,
      baseTransform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      geometryBounds: {
        min: [0, 0, 0],
        max: [1, 1, 1],
        size: [1, 1, 1],
        unit: "m",
        space: "object-local",
      },
    };
    store.saveScene(project.id, 0, {
      models: [
        {
          source: { path: join(root, "external.step"), sha256: hash },
          resource: {
            path: join(root, "resource.glb"),
            format: "glb",
            byteLength: 4,
            sha256: hash,
          },
          objects: [
            { ...object, id: "a", name: "a" },
            { ...object, id: "b", name: "b" },
          ],
          warnings: [],
          complete: false,
        },
      ],
    });
    const before = scenes.get(project.id);
    const model = before.models[0];
    assert.ok(model);
    const abort = new AbortController();
    const pending = scenes.measureDistance(
      {
        projectId: project.id,
        revision: before.revision,
        first: { modelId: model.id, objectId: "a" },
        second: { modelId: model.id, objectId: "b" },
      },
      { signal: abort.signal },
    );
    const rejected = assert.rejects(pending, /abort|取消/i);
    const marker = join(dataRoot, "projects", project.id, "scene", "distance-started");
    let started = false;
    for (let tries = 0; tries < 100; tries++) {
      try {
        await access(marker);
        started = true;
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    assert.equal(started, true);
    abort.abort();
    await rejected;
    assert.deepEqual(scenes.get(project.id), before);
  } finally {
    await scenes.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("测量期间场景发生变更时拒绝过期结果", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-distance-stale-"));
  const dataRoot = join(root, "data");
  const store = openProjectStore(dataRoot);
  const scenes = createSceneService({
    dataRoot,
    store,
    pythonExecutable: "python3",
    workerPath: resolve("tests/backend/fixtures/hanging-distance-worker.py"),
  });
  try {
    const project = store.createProject({ name: "场景", mode: "scene", path: root });
    const hash = "a".repeat(64);
    const object = {
      parentId: null,
      sourceKey: "/synthetic",
      rigidTransform: true,
      baseTransform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      geometryBounds: {
        min: [0, 0, 0],
        max: [1, 1, 1],
        size: [1, 1, 1],
        unit: "m",
        space: "object-local",
      },
    };
    store.saveScene(project.id, 0, {
      models: [
        {
          source: { path: join(root, "external.step"), sha256: hash },
          resource: {
            path: join(root, "resource.glb"),
            format: "glb",
            byteLength: 4,
            sha256: hash,
          },
          objects: [
            { ...object, id: "a", name: "a" },
            { ...object, id: "b", name: "b" },
          ],
          warnings: [],
          complete: false,
        },
      ],
    });
    const before = scenes.get(project.id);
    const model = before.models[0];
    assert.ok(model);
    const pending = scenes.measureDistance({
      projectId: project.id,
      revision: before.revision,
      first: { modelId: model.id, objectId: "a" },
      second: { modelId: model.id, objectId: "b" },
    });
    const rejected = assert.rejects(pending, /版本|过期/);
    const dir = join(dataRoot, "projects", project.id, "scene");
    let started = false;
    for (let tries = 0; tries < 100; tries++) {
      try {
        await access(join(dir, "distance-started"));
        started = true;
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    assert.equal(started, true);
    const changed = scenes.setTransform({
      projectId: project.id,
      modelId: model.id,
      objectId: "a",
      revision: before.revision,
      transform: { position: [1, 0, 0], rotation: [0, 0, 0, 1] },
    });
    await writeFile(join(dir, "distance-release"), "release");
    await rejected;
    assert.deepEqual(scenes.get(project.id), changed);
  } finally {
    await scenes.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
