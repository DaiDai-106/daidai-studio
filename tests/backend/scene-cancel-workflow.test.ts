import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";

test("取消阻塞 worker 仅影响对应项目且保留原场景", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-scene-cancel-"));
  const dataRoot = join(root, "data");
  const hang = join(root, "hang.step");
  const otherSource = join(root, "other.step");
  await writeFile(hang, "step-a");
  await writeFile(otherSource, "step-b");
  const app = await openApplication({
    dataRoot,
    workerPath: resolve("tests/backend/fixtures/hanging-scene-worker.py"),
    pythonExecutable: "python3",

    publish: () => {},
  });
  try {
    const first = await app.request("project.create", { name: "A", mode: "scene", path: root });
    const second = await app.request("project.create", { name: "B", mode: "scene", path: root });
    const baseline = await app.request("scene.import", {
      projectId: first.id,
      path: otherSource,
      operation: "replace",
      revision: 0,
    });
    const pending = app.request("scene.import", {
      projectId: first.id,
      path: hang,
      operation: "replace",
      revision: baseline.revision,
    });
    const rejected = assert.rejects(pending, /取消|abort/i);
    const marker = join(dataRoot, "projects", first.id, "scene", "request-started");
    let ready = false;
    for (let tries = 0; tries < 100; tries++) {
      try {
        if ((await readFile(marker, "utf8")) === "hang.step") {
          ready = true;
          break;
        }
      } catch {
        /* worker 尚未写入标记。 */
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.equal(ready, true);
    const other = await app.request("scene.import", {
      projectId: second.id,
      path: otherSource,
      operation: "replace",
      revision: 0,
    });
    assert.equal(other.revision, 1);
    await app.request("scene.cancelImport", { projectId: first.id });
    await rejected;
    assert.deepEqual(await app.request("scene.get", { projectId: first.id }), baseline);
    assert.equal((await app.request("scene.get", { projectId: second.id })).revision, 1);
    assert.equal(await readFile(hang, "utf8"), "step-a");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
