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

test("旧场景项目及会话不出现在 Coding 版本，原数据保留", async () => {
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
    assert.equal(store.getProject(old.id), undefined);
    assert.equal(store.getConversation(oldChat.id), undefined);
    assert.deepEqual(
      store.listProjects().map((project) => project.id),
      [current.id],
    );
    assert.deepEqual(
      store.listConversationPage(undefined, 1).items.map((item) => item.id),
      [currentChat.id],
    );
    assert.throws(() => store.restoreProject(old.id), /项目不存在/);
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
