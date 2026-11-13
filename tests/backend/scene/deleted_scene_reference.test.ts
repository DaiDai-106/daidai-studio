import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../../src/backend/application.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";

test("即使 revision 最新，已删除的场景对象也不能作为会话引用", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-deleted-reference-"));
  const dataRoot = join(root, "data");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const app = await openApplication({
    dataRoot,

    publish() {},
  });
  try {
    const project = await app.request("project.create", {
      name: "scene",
      mode: "scene",
      path: workspace,
    });
    const store = openProjectStore(dataRoot);
    try {
      store.saveScene(project.id, 0, {
        models: [
          {
            source: { path: join(root, "missing.step"), sha256: "a".repeat(64) },
            resource: {
              path: join(root, "fake.glb"),
              format: "glb",
              byteLength: 1,
              sha256: "b".repeat(64),
            },
            objects: [{ id: "deleted-object", name: "removed", parentId: null, deleted: true }],
            complete: false,
            warnings: [],
          },
        ],
      });
    } finally {
      store.close();
    }
    const scene = await app.request("scene.get", { projectId: project.id });
    const model = scene.models[0];
    assert.ok(model);
    const conversation = await app.request("conversation.create", { projectId: project.id });
    await assert.rejects(
      app.request("conversation.send", {
        id: conversation.id,
        requestId: "req",
        text: "分析这个对象",
        sceneReference: {
          importId: model.id,
          objectId: "deleted-object",
          revision: scene.revision,
        },
      }),
      /场景引用不属于当前项目或对象不存在/,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
