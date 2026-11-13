import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPiHistory } from "../../../src/backend/agent/pi_history.ts";
import { projectPiHistory } from "../../../src/backend/agent/pi_projection.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";

test("Pi 恢复 1.3 生成的文本和图片会话，并继续追加及分叉", () => {
  const root = mkdtempSync(join(tmpdir(), "dai-pi13-history-"));
  const data = join(root, "data");
  const store = openProjectStore(data);
  try {
    const project = store.createProject({ name: "兼容测试", mode: "coding", path: root });
    const conversation = store.createConversation(project.id);
    const directory = join(data, "sessions", project.id);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "pi13.jsonl");
    // 这个样本由 Pi 1.3.0 的 SessionManager 生成，不包含真实用户数据。
    copyFileSync(new URL("../fixtures/pi_1_3_session.jsonl", import.meta.url), path);
    store.updateConversation(conversation.id, { sessionFile: path, hasMessages: true });
    const history = createPiHistory(store, data);
    const session = history.open(conversation.id);
    const { messages } = projectPiHistory(session.getBranch());
    assert.equal(messages[0]?.text, "旧版会话测试");
    assert.deepEqual(messages[0]?.images, [
      {
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
      },
    ]);
    session.appendMessage({ role: "user", content: "新版本消息", timestamp: 2 });
    assert.equal(
      history.open(history.fork(conversation.id).id).buildSessionContext().messages.length,
      2,
    );
    history.forget(conversation.id);
    assert.equal(history.open(conversation.id).buildSessionContext().messages.length, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi 原生会话重启恢复，分叉复制上下文后互不影响", () => {
  const root = mkdtempSync(join(tmpdir(), "dai-pi-history-"));
  const data = join(root, "data");
  try {
    let store = openProjectStore(data);
    const project = store.createProject({ name: "场景", mode: "scene", path: root });
    const a = store.createConversation(project.id);
    const b = store.createConversation(project.id);
    let history = createPiHistory(store, data);
    const original = history.open(a.id);
    original.appendMessage({
      role: "user",
      content: [{ type: "text", text: "原始上下文" }],
      timestamp: Date.now(),
    });
    assert.equal(history.open(b.id).buildSessionContext().messages.length, 0);
    const branch = history.fork(a.id);
    assert.equal(history.open(branch.id).buildSessionContext().messages.length, 1);
    history.open(branch.id).appendMessage({
      role: "user",
      content: [{ type: "text", text: "分叉的新消息" }],
      timestamp: Date.now(),
    });
    assert.equal(history.open(a.id).buildSessionContext().messages.length, 1);
    store.close();
    store = openProjectStore(data);
    history = createPiHistory(store, data);
    assert.equal(history.open(a.id).buildSessionContext().messages.length, 1);
    assert.equal(history.open(branch.id).buildSessionContext().messages.length, 2);
    assert.equal(history.open(b.id).buildSessionContext().messages.length, 0);
    const branchFile = store.getConversation(branch.id)?.sessionFile;
    assert.ok(branchFile);
    unlinkSync(branchFile);
    assert.throws(() => createPiHistory(store, data).open(branch.id), /历史文件丢失/);
    assert.throws(() => createPiHistory(store, data).fork(branch.id), /历史文件丢失/);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
