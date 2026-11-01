import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";

test("工作区会话超过 100 条时可继续分页且不访问项目目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-pagination-"));
  const app = await openApplication({
    dataRoot: join(root, "data"),

    publish: () => {},
  });
  try {
    const project = await app.request("project.create", {
      name: "test",
      path: root,
      mode: "general",
    });
    for (let index = 0; index < 103; index++)
      await app.request("conversation.create", { projectId: project.id });
    const first = await app.request("workspace.get", {});
    assert.equal(first.projects[0]?.available, null);
    assert.equal(first.conversations.length, 100);
    assert.ok(first.nextCursor);
    const second = await app.request("workspace.get", { cursor: first.nextCursor });
    assert.equal(second.conversations.length, 3);
    assert.equal(second.nextCursor, null);
    assert.equal(
      new Set([...first.conversations, ...second.conversations].map((item) => item.id)).size,
      103,
    );
    assert.equal((await app.request("project.refresh", { id: project.id })).available, true);
    await assert.rejects(app.request("workspace.get", { cursor: "invalid" }), /分页游标无效/);
    const secondProject = await app.request("project.create", {
      name: "同目录另一个项目",
      path: root,
      mode: "general",
    });
    await app.request("project.remove", { id: project.id });
    assert.deepEqual(
      (await app.request("project.hidden", {})).map((item) => item.id),
      [project.id],
    );
    assert.equal((await app.request("workspace.get", {})).projects[0]?.id, secondProject.id);
    assert.equal((await app.request("workspace.get", {})).conversations.length, 0);
    await app.request("project.restore", { id: project.id });
    assert.equal((await app.request("workspace.get", {})).conversations.length, 100);
    assert.deepEqual(await app.request("project.hidden", {}), []);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
