import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { openApplication } from "../../src/backend/application.ts";
import { validateResult } from "../../src/contracts/application.ts";
import { readSceneResource } from "../support/sceneResource.ts";

const python = process.env.DAI_SCENE_TEST_PYTHON;
test("5000 实例的真实 STEP 可导入、持久化并在重启后恢复", {
  timeout: 180_000,
  skip: python ? false : "需要配置 DAI_SCENE_TEST_PYTHON",
}, async () => {
  assert.ok(python);
  const root = await mkdtemp(join(tmpdir(), "dai-large-scene-"));
  const workspace = join(root, "workspace");
  const source = join(root, "large.step");
  await mkdir(workspace);
  await promisify(execFile)(
    python,
    [
      "-c",
      "import sys;sys.path.insert(0,sys.argv[1]);from assembly_fixture import write_large_assembly;write_large_assembly(sys.argv[2],5000)",
      resolve("tests/python"),
      source,
    ],
    { timeout: 100_000 },
  );
  const original = createHash("sha256")
    .update(await readFile(source))
    .digest("hex");
  const options = {
    dataRoot: join(root, "data"),
    workerPath: resolve("packages/scene/python/worker.py"),
    pythonExecutable: python,

    publish() {},
  };
  let app = await openApplication(options);
  try {
    const project = await app.request("project.create", {
      name: "large",
      mode: "scene",
      path: workspace,
    });
    const saved = await app.request("scene.import", {
      projectId: project.id,
      path: source,
      operation: "replace",
      revision: 0,
    });
    const model = saved.models[0];
    validateResult("scene.import", saved);
    assert.ok(model);
    assert.equal(model.objects.length, 5001);
    assert.ok(Buffer.byteLength(JSON.stringify(saved), "utf8") > 1024 * 1024);
    const url = new URL(model.resource.url);
    await app.close();
    app = await openApplication(options);
    const restored = await app.request("scene.get", { projectId: project.id });
    validateResult("scene.get", restored);
    assert.equal(restored.revision, saved.revision);
    assert.equal(restored.models[0]?.objects.length, 5001);
    const resource = await app.resolveResource(url.hostname, url.pathname.slice(1));
    assert.equal(
      (await readSceneResource(options.dataRoot, resource, url.pathname.slice(1)))
        .subarray(0, 4)
        .toString(),
      "glTF",
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
      original,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
