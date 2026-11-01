import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createSceneRuntime, type SceneImportResult } from "../../packages/scene/src/runtime.ts";

const python = process.env.DAI_SCENE_TEST_PYTHON;

test("真实 Python worker 从 STEP 装配生成可识别 GLB 与对象", {
  timeout: 30_000,
  skip: python ? false : "设置 DAI_SCENE_TEST_PYTHON 为已安装场景依赖的 Python 解释器",
}, async () => {
  assert.ok(python);
  const directory = await mkdtemp(join(tmpdir(), "dai-real-step-"));
  const source = join(directory, "assembly.step");
  const runtime = createSceneRuntime({
    projectId: "real",
    cwd: directory,
    dataDir: join(directory, "data"),
    pythonExecutable: python,
  });
  try {
    await promisify(execFile)(python, [
      "-c",
      "import sys; sys.path.insert(0,sys.argv[1]); from assembly_fixture import write_assembly; write_assembly(sys.argv[2], True)",
      resolve("tests/python"),
      source,
    ]);
    const result = (await runtime.call("scene_import", { path: source })) as SceneImportResult;
    assert.equal(result.objects.length, 7);
    const bytes = await readFile(result.resource.path);
    assert.equal(bytes.toString("ascii", 0, 4), "glTF");
    const length = bytes.readUInt32LE(12);
    const gltf = JSON.parse(bytes.subarray(20, 20 + length).toString("utf8"));
    for (const object of result.objects) {
      assert.equal(gltf.nodes[object.gltfNode].extras.daiObjectId, object.id);
      assert.equal(object.baseTransform.position.length, 3);
    }
    const blocks = result.objects.filter((object) => object.name === "FirstBlock");
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0]?.geometryBounds, blocks[1]?.geometryBounds);
    assert.equal(blocks[0]?.geometryBounds?.unit, "m");
    assert.equal(blocks[0]?.geometryBounds?.space, "object-local");
    assert.ok(Math.abs((blocks[0]?.geometryBounds?.size[2] ?? 0) - 0.03) < 1e-6);
    assert.equal(result.complete, false);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("真实 worker 不会通过项目目录符号链接在数据根外创建文件", {
  timeout: 30_000,
  skip: python && process.platform !== "win32" ? false : "需要场景 Python 与 POSIX 符号链接",
}, async () => {
  assert.ok(python);
  const directory = await mkdtemp(join(tmpdir(), "dai-real-symlink-"));
  const source = join(directory, "assembly.step");
  const root = join(directory, "data");
  const outside = join(directory, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(join(outside, "sentinel"), "unchanged");
  await symlink(outside, join(root, "projects"));
  const runtime = createSceneRuntime({
    projectId: "real",
    cwd: directory,
    storageRoot: root,
    dataDir: join(root, "projects", "project", "scene"),
    pythonExecutable: python,
  });
  try {
    await promisify(execFile)(python, [
      "-c",
      "import sys;sys.path.insert(0,sys.argv[1]);from assembly_fixture import write_assembly;write_assembly(sys.argv[2])",
      resolve("tests/python"),
      source,
    ]);
    await assert.rejects(runtime.call("scene_import", { path: source }), /符号链接|目录/);
    assert.deepEqual(await readdir(outside), ["sentinel"]);
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "unchanged");
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
