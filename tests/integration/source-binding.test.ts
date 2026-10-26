import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openRuntime } from "../../src/backend/runtime.ts";

test("STEP bindings persist per conversation, share project source identity and inherit the project selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-source-binding-"));
  const vault = { available: false, read: async () => "{}", write: async () => {} };
  let app = await openRuntime(root, vault, () => {});
  try {
    await mkdir(join(root, "first"));
    await mkdir(join(root, "second"));
    await writeFile(join(root, "first", "part.step"), "source, not parsed");
    await writeFile(join(root, "first", "other.stp"), "other source, not parsed");
    await writeFile(join(root, "second", "part.step"), "same filename, different project");
    const project = await app.request("project.open", { path: join(root, "first") });
    const a = await app.request("conversation.create", { projectId: project.id });
    assert.equal(a.source, null);
    const selected = await app.request("conversation.selectStep", {
      id: a.id,
      relativePath: "part.step",
    });
    assert.ok(selected.source);
    const b = await app.request("conversation.create", { projectId: project.id });
    assert.deepEqual(b.source, selected.source);
    const other = await app.request("conversation.selectStep", {
      id: b.id,
      relativePath: "other.stp",
    });
    assert.notEqual(other.source?.id, selected.source.id);
    assert.deepEqual(
      (await app.request("workspace.get", {})).conversations.find((item) => item.id === a.id)
        ?.source,
      selected.source,
    );
    await assert.rejects(
      app.request("conversation.selectStep", { id: b.id, relativePath: "../second/part.step" }),
    );
    assert.deepEqual(
      (await app.request("workspace.get", {})).conversations.find((item) => item.id === b.id)
        ?.source,
      other.source,
    );
    if (process.platform !== "win32") {
      await symlink(join(root, "second", "part.step"), join(root, "first", "linked.step"));
      await assert.rejects(
        app.request("conversation.selectStep", { id: b.id, relativePath: "linked.step" }),
        /符号链接/,
      );
    }
    const project2 = await app.request("project.open", { path: join(root, "second") });
    const c = await app.request("conversation.create", { projectId: project2.id });
    const separate = await app.request("conversation.selectStep", {
      id: c.id,
      relativePath: "part.step",
    });
    assert.notEqual(separate.source?.id, selected.source.id);
    await app.close();
    app = await openRuntime(root, vault, () => {});
    const restored = await app.request("workspace.get", {});
    assert.deepEqual(
      restored.conversations.find((item) => item.id === a.id)?.source,
      selected.source,
    );
    assert.deepEqual(restored.conversations.find((item) => item.id === b.id)?.source, other.source);
    const d = await app.request("conversation.create", { projectId: project.id });
    assert.deepEqual(d.source, other.source);
    await app.request("conversation.selectStep", { id: d.id, relativePath: "" });
    assert.equal(
      (await app.request("conversation.create", { projectId: project.id })).source,
      null,
    );
    await app.request("conversation.delete", { id: a.id });
    await assert.rejects(
      app.request("conversation.selectStep", { id: a.id, relativePath: "part.step" }),
      /已删除/,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
