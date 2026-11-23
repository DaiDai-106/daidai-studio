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

test("拒绝过期项目数据库，不补列或改写原数据", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const root = mkdtempSync(join(tmpdir(), "dai-outdated-project-"));
  const file = join(root, "projects.sqlite");
  try {
    const database = new DatabaseSync(file);
    database.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT);
      INSERT INTO projects VALUES ('previous', '原始项目', '/original');`);
    database.close();
    const original = readFileSync(file);
    assert.throws(() => openProjectStore(root), /项目数据库格式无效或已过期/);
    assert.deepEqual(readFileSync(file), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
