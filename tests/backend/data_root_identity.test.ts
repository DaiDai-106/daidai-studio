import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createSceneRuntime } from "../../packages/scene/src/runtime.ts";
import { openApplication } from "../../src/backend/application.ts";

const linuxOnly = { skip: process.platform !== "linux" ? "需要 Linux 目录句柄" : false };

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "dai-root-identity-"));
  const first = join(base, "data-first");
  const outside = join(base, "outside");
  const alias = join(base, "data-alias");
  const work = join(base, "work");
  await Promise.all([mkdir(first), mkdir(outside), mkdir(work)]);
  await symlink(first, alias, "dir");
  return { base, first, outside, alias, work };
}

test("应用启动后切换配置的数据根链接，导入拒绝且外部目录不写入", linuxOnly, async () => {
  const paths = await fixture();
  const app = await openApplication({ dataRoot: paths.alias, publish() {} });
  try {
    const project = await app.request("project.create", {
      name: "scene",
      mode: "scene",
      path: paths.work,
    });
    const source = join(paths.work, "sample.step");
    await writeFile(source, "sample STEP");
    await unlink(paths.alias);
    await symlink(paths.outside, paths.alias, "dir");
    await assert.rejects(
      app.request("scene.import", {
        projectId: project.id,
        path: source,
        revision: 0,
        operation: "replace",
      }),
      /身份|根目录/,
    );
    assert.deepEqual(await readdir(paths.outside), []);
    assert.equal((await app.request("scene.get", { projectId: project.id })).revision, 0);
    const workspace = await app.request("workspace.get", {});
    assert.equal(workspace.dataRoot, paths.first);
  } finally {
    await app.close();
    await rm(paths.base, { recursive: true, force: true });
  }
});

test("应用启动后真实数据根目录被替换，导入拒绝且新目录不写入", linuxOnly, async () => {
  const paths = await fixture();
  const app = await openApplication({ dataRoot: paths.alias, publish() {} });
  try {
    const project = await app.request("project.create", {
      name: "scene",
      mode: "scene",
      path: paths.work,
    });
    const source = join(paths.work, "sample.step");
    await writeFile(source, "sample STEP");
    await rename(paths.first, `${paths.first}-original`);
    await mkdir(paths.first);
    await assert.rejects(
      app.request("scene.import", {
        projectId: project.id,
        path: source,
        revision: 0,
        operation: "replace",
      }),
      /身份|根目录/,
    );
    assert.deepEqual(await readdir(paths.first), []);
  } finally {
    await app.close();
    await rm(paths.base, { recursive: true, force: true });
  }
});

test("Python worker 独立校验数据根身份并拒绝被切换的链接", {
  ...linuxOnly,
  skip:
    process.platform !== "linux"
      ? "需要 Linux 目录句柄"
      : process.env.DAI_SCENE_TEST_PYTHON
        ? false
        : "需要场景 Python",
  timeout: 60_000,
}, async () => {
  const python = process.env.DAI_SCENE_TEST_PYTHON;
  assert.ok(python);
  const paths = await fixture();
  const original = await stat(paths.first, { bigint: true });
  const expectedRoot = { dev: original.dev.toString(), ino: original.ino.toString() };
  const projectId = "12345678-1234-4234-8234-123456789abc";
  const scene = join(paths.alias, "projects", projectId, "scene");
  await mkdir(scene, { recursive: true });
  const source = join(paths.work, "model.step");
  await promisify(execFile)(python, [
    "-c",
    "import sys;sys.path.insert(0,'tests/python');from assembly_fixture import write_assembly;write_assembly(sys.argv[1])",
    source,
  ]);
  await unlink(paths.alias);
  await symlink(paths.outside, paths.alias, "dir");
  const runtime = createSceneRuntime({
    projectId,
    cwd: paths.work,
    dataDir: scene,
    storageRoot: paths.alias,
    expectedRoot,
    pythonExecutable: python,
    workerPath: resolve("packages/scene/python/worker.py"),
  });
  try {
    await assert.rejects(runtime.call("scene_import", { path: source }));
    assert.deepEqual(await readdir(paths.outside), []);
  } finally {
    await runtime.dispose();
    await rm(paths.base, { recursive: true, force: true });
  }
});
