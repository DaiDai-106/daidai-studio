import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { constants } from "node:fs";
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../../src/backend/application.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";
import { createSceneService } from "../../../src/backend/scene/scene_service.ts";
import type { ApplicationEvent } from "../../../src/contracts/application.ts";

test("重定位只接受相同 STEP，保留对象、位姿及关节并跨重启恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-relocate-"));
  const dataRoot = join(root, "data");
  const oldPath = join(root, "old.step");
  const newPath = join(root, "new.step");
  const badPath = join(root, "bad.step");
  const aliasPath = join(root, "alias.step");
  const bytes = Buffer.from("a selected step file");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await writeFile(oldPath, bytes);
  await writeFile(badPath, "other file");
  const events: ApplicationEvent[] = [];
  const options = {
    dataRoot,
    publish: (event: ApplicationEvent) => events.push(event),
  };
  let app = await openApplication(options);
  const store = openProjectStore(dataRoot);
  try {
    const project = await app.request("project.create", {
      name: "场景",
      mode: "scene",
      path: root,
    });
    const object = {
      id: "part",
      name: "part",
      parentId: null,
      transform: { position: [1, 2, 3], rotation: [0, 0, 0, 1] },
    };
    store.saveScene(project.id, 0, {
      models: [
        {
          source: { path: oldPath, sha256: hash },
          resource: {
            path: join(root, "stored.glb"),
            format: "glb",
            byteLength: 4,
            sha256: "a".repeat(64),
          },
          objects: [object, { id: "other", name: "other", parentId: null }],
          warnings: [],
          complete: false,
        },
      ],
      joints: [],
    });
    const initial = await app.request("scene.get", { projectId: project.id });
    const model = initial.models[0];
    assert.ok(model);
    const sceneService = createSceneService({ store, dataRoot });
    const draft = sceneService.createJointDraft({
      projectId: project.id,
      revision: initial.revision,
      parent: { modelId: model.id, objectId: "part" },
      child: { modelId: model.id, objectId: "other" },
      type: "fixed",
    });
    const candidate = draft.joints[0];
    assert.ok(candidate);
    const before = await app.request("scene.confirmJoint", {
      projectId: project.id,
      revision: draft.revision,
      candidateId: candidate.id,
    });
    await rename(oldPath, newPath);
    const input = {
      projectId: project.id,
      modelId: model.id,
      revision: before.revision,
      path: badPath,
    };
    events.length = 0;
    await assert.rejects(app.request("scene.relocateSource", input), /哈希|内容|一致/);
    assert.equal(events.filter((event) => event.type === "scene.changed").length, 0);
    assert.equal(
      (await app.request("scene.get", { projectId: project.id })).revision,
      before.revision,
    );
    await assert.rejects(
      app.request("scene.relocateSource", {
        ...input,
        revision: before.revision + 1,
        path: newPath,
      }),
      /版本/,
    );
    if (process.platform === "linux") {
      const fifo = join(root, "fifo.step");
      assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
      const originalOpen = fs.promises.open;
      let checked = false;
      try {
        fs.promises.open = (async (path, flags, mode) => {
          if (String(path) === fifo) {
            checked = true;
            assert.equal(typeof flags, "number");
            assert.ok((flags as number) & constants.O_NONBLOCK);
          }
          return originalOpen(path, flags, mode);
        }) as typeof originalOpen;
        syncBuiltinESMExports();
        await assert.rejects(
          app.request("scene.relocateSource", { ...input, path: fifo }),
          /不可用/,
        );
        assert.equal(checked, true);
      } finally {
        fs.promises.open = originalOpen;
        syncBuiltinESMExports();
      }
    }
    await symlink(newPath, aliasPath);
    const relocated = await app.request("scene.relocateSource", { ...input, path: aliasPath });
    assert.equal(relocated.revision, before.revision + 1);
    assert.deepEqual(
      events.filter((event) => event.type === "scene.changed"),
      [{ type: "scene.changed", projectId: project.id, revision: relocated.revision }],
    );
    assert.equal(relocated.models[0]?.id, model.id);
    assert.equal(relocated.models[0]?.sourcePath, aliasPath);
    assert.deepEqual(relocated.models[0]?.objects, model.objects);
    assert.deepEqual(relocated.joints, before.joints);
    assert.equal(relocated.joints[0]?.status, "confirmed");
    assert.deepEqual(await readFile(newPath), bytes);
    await app.close();
    app = await openApplication(options);
    assert.deepEqual(await app.request("scene.get", { projectId: project.id }), relocated);
  } finally {
    store.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
