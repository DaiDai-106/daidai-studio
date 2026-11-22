import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectStore } from "../../../src/backend/projects/store.ts";

test("同一目录的不同项目和会话相互独立并在重启后恢复", () => {
  const root = mkdtempSync(join(tmpdir(), "dai-project-store-"));
  const data = join(root, "data");
  const directory = join(root, "work");
  mkdirSync(directory);
  writeFileSync(join(directory, "user.txt"), "用户文件");
  try {
    let store = openProjectStore(data);
    const first = store.createProject({ name: "代码项目", mode: "coding", path: directory });
    const second = store.createProject({ name: "另一个项目", mode: "coding", path: directory });
    assert.notEqual(first.id, second.id);
    const a = store.createConversation(first.id);
    const b = store.createConversation(first.id);
    const c = store.createConversation(second.id);
    assert.equal(a.accessMode, "ask");
    store.updateConversation(a.id, { accessMode: "full" });
    assert.equal(store.getConversation(b.id)?.accessMode, "ask");
    store.updateConversation(a.id, { draft: "只属于 A" });
    assert.equal(store.getConversation(b.id)?.draft, "");
    assert.deepEqual(
      store
        .listConversationPage()
        .items.filter((item) => item.projectId === second.id)
        .map((item) => item.id),
      [c.id],
    );
    store.hideProject(first.id);
    assert.equal(store.getProject(first.id), undefined);
    store.close();

    store = openProjectStore(data);
    assert.deepEqual(
      store.listHiddenProjects().map((item) => item.id),
      [first.id],
    );
    assert.equal(store.getConversation(a.id)?.draft, "只属于 A");
    assert.equal(store.getConversation(a.id)?.accessMode, "full");
    store.restoreProject(first.id);
    assert.equal(store.getProject(first.id)?.mode, "coding");
    assert.equal(store.getConversation(a.id)?.draft, "只属于 A");
    store.hideProject(first.id);
    assert.equal(store.getProject(first.id), undefined);
    assert.equal(store.getConversation(a.id)?.draft, "只属于 A");
    assert.equal(store.getProject(second.id)?.path, directory);
    assert.equal(readFileSync(join(directory, "user.txt"), "utf8"), "用户文件");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("项目名称和目录必须有效", () => {
  const root = mkdtempSync(join(tmpdir(), "dai-project-store-"));
  try {
    const store = openProjectStore(join(root, "data"));
    assert.throws(
      () => store.createProject({ name: "  ", mode: "coding", path: root }),
      /名称无效/,
    );
    assert.throws(
      () => store.createProject({ name: "A", mode: "coding", path: "relative" }),
      /绝对路径/,
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("旧场景项目及会话可恢复，SQLite 场景原数据保留", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const root = mkdtempSync(join(tmpdir(), "dai-legacy-project-"));
  const data = join(root, "data");
  try {
    let store = openProjectStore(data);
    const old = store.createProject({ name: "旧项目", mode: "coding", path: root });
    const oldChat = store.createConversation(old.id);
    const current = store.createProject({ name: "场景", mode: "coding", path: root });
    const currentChat = store.createConversation(current.id);
    store.close();

    const database = new DatabaseSync(join(data, "projects.sqlite"));
    database.prepare("UPDATE projects SET mode = ? WHERE id = ?").run("scene", old.id);
    database.exec(
      "CREATE TABLE scenes (project_id TEXT PRIMARY KEY, revision INTEGER, document TEXT)",
    );
    database.prepare("INSERT INTO scenes VALUES (?, ?, ?)").run(old.id, 1, '{"saved":true}');
    database.close();

    store = openProjectStore(data);
    assert.equal(store.getProject(old.id)?.mode, "scene");
    assert.equal(store.getConversation(oldChat.id)?.id, oldChat.id);
    assert.equal(store.hasLegacyScene(old.id), true);
    assert.deepEqual(
      new Set(store.listProjects().map((project) => project.id)),
      new Set([current.id, old.id]),
    );
    assert.deepEqual(
      new Set(store.listConversationPage(undefined, 10).items.map((item) => item.id)),
      new Set([currentChat.id, oldChat.id]),
    );
    store.hideProject(old.id);
    assert.equal(store.listHiddenProjects()[0]?.id, old.id);
    assert.equal(store.restoreProject(old.id).id, old.id);
    store.close();

    const unchanged = new DatabaseSync(join(data, "projects.sqlite"));
    assert.equal(
      (unchanged.prepare("SELECT mode FROM projects WHERE id = ?").get(old.id) as { mode: string })
        .mode,
      "scene",
    );
    assert.ok(unchanged.prepare("SELECT id FROM conversations WHERE id = ?").get(oldChat.id));
    assert.deepEqual(
      {
        ...unchanged
          .prepare("SELECT revision, document FROM scenes WHERE project_id = ?")
          .get(old.id),
      },
      { revision: 1, document: '{"saved":true}' },
    );
    unchanged.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
