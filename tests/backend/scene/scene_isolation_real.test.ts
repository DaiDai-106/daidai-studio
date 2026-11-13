import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { openApplication } from "../../../src/backend/application.ts";
import { readSceneResource } from "../../support/scene_resource.ts";

const python = process.env.DAI_SCENE_TEST_PYTHON;

test("同一工作目录的两个项目导入、删除和重启互相隔离", {
  timeout: 90_000,
  skip: python ? false : "需要配置 DAI_SCENE_TEST_PYTHON",
}, async () => {
  assert.ok(python);
  const root = await mkdtemp(join(tmpdir(), "dai-real-isolation-"));
  const cwd = join(root, "workspace");
  const source = join(root, "outside.step");
  await mkdir(cwd);
  await promisify(execFile)(python, [
    "-c",
    "import sys;sys.path.insert(0,sys.argv[1]);from assembly_fixture import write_assembly;write_assembly(sys.argv[2],True)",
    resolve("tests/python"),
    source,
  ]);
  const original = await readFile(source);
  const options = {
    dataRoot: join(root, "data"),
    workerPath: resolve("packages/scene/python/worker.py"),
    pythonExecutable: python,

    publish() {},
  };
  let app = await openApplication(options);
  try {
    const a = await app.request("project.create", { name: "A", mode: "scene", path: cwd });
    const b = await app.request("project.create", { name: "B", mode: "scene", path: cwd });
    assert.notEqual(a.id, b.id);
    const [sceneA, sceneB] = await Promise.all([
      app.request("scene.import", {
        projectId: a.id,
        path: source,
        operation: "replace",
        revision: 0,
      }),
      app.request("scene.import", {
        projectId: b.id,
        path: source,
        operation: "replace",
        revision: 0,
      }),
    ]);
    const modelA = sceneA.models[0];
    const modelB = sceneB.models[0];
    assert.ok(modelA && modelB);
    const objectA = modelA.objects.find((item) => item.geometryBounds);
    const objectB = modelB.objects.find((item) => item.geometryBounds);
    assert.ok(objectA && objectB);
    const resourceA = new URL(modelA.resource.url);
    const resourceB = new URL(modelB.resource.url);
    assert.notEqual(resourceA.hostname, resourceB.hostname);
    await assert.rejects(
      app.request("scene.deleteObject", {
        projectId: a.id,
        modelId: modelB.id,
        objectId: objectB.id,
        revision: 1,
      }),
      /场景模型不存在/,
    );
    const deleted = await app.request("scene.deleteObject", {
      projectId: a.id,
      modelId: modelA.id,
      objectId: objectA.id,
      revision: 1,
    });
    assert.equal(deleted.models[0]?.objects.find((item) => item.id === objectA.id)?.deleted, true);
    assert.deepEqual(await app.request("scene.get", { projectId: b.id }), sceneB);
    await app.close();
    app = await openApplication(options);
    assert.deepEqual(await app.request("scene.get", { projectId: a.id }), deleted);
    assert.deepEqual(await app.request("scene.get", { projectId: b.id }), sceneB);
    const bResource = await app.resolveResource(resourceB.hostname, resourceB.pathname.slice(1));
    assert.equal(
      (await readSceneResource(options.dataRoot, bResource, resourceB.pathname.slice(1)))
        .subarray(0, 4)
        .toString(),
      "glTF",
    );
    assert.deepEqual(await readFile(source), original);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("用户配置的数据根是符号链接时可导入场景并在重启后恢复", {
  timeout: 60_000,
  skip: python && process.platform !== "win32" ? false : "需要场景 Python 和 POSIX 符号链接",
}, async () => {
  assert.ok(python);
  const root = await mkdtemp(join(tmpdir(), "dai-root-alias-"));
  const cwd = join(root, "workspace");
  const actual = join(root, "actual-data");
  const alias = join(root, "data-alias");
  const source = join(root, "outside.step");
  await Promise.all([mkdir(cwd), mkdir(actual)]);
  await symlink(actual, alias);
  await promisify(execFile)(python, [
    "-c",
    "import sys;sys.path.insert(0,sys.argv[1]);from assembly_fixture import write_assembly;write_assembly(sys.argv[2])",
    resolve("tests/python"),
    source,
  ]);
  const options = {
    dataRoot: alias,
    workerPath: resolve("packages/scene/python/worker.py"),
    pythonExecutable: python,

    publish() {},
  };
  let app = await openApplication(options);
  try {
    const project = await app.request("project.create", {
      name: "链接根",
      mode: "scene",
      path: cwd,
    });
    const saved = await app.request("scene.import", {
      projectId: project.id,
      path: source,
      operation: "replace",
      revision: 0,
    });
    assert.equal(saved.models.length, 1);
    const model = saved.models[0];
    assert.ok(model);
    await app.close();
    app = await openApplication(options);
    assert.deepEqual(await app.request("scene.get", { projectId: project.id }), saved);
    const uri = new URL(model.resource.url);
    const resource = await app.resolveResource(uri.hostname, uri.pathname.slice(1));
    assert.equal(
      (await readSceneResource(options.dataRoot, resource, uri.pathname.slice(1)))
        .subarray(0, 4)
        .toString(),
      "glTF",
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
