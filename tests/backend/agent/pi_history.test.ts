import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPiHistory } from "../../../src/backend/agent/pi_history.ts";
import { projectPiHistory } from "../../../src/backend/agent/pi_projection.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";

test("Pi 原生会话重启恢复，分叉复制上下文后互不影响", () => {
  const root = mkdtempSync(join(tmpdir(), "dai-pi-history-"));
  const data = join(root, "data");
  try {
    let store = openProjectStore(data);
    const project = store.createProject({ name: "场景", mode: "coding", path: root });
    const a = store.createConversation(project.id);
    const b = store.createConversation(project.id);
    let history = createPiHistory(store, data);
    const original = history.open(a.id);
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
    };
    original.appendMessage({
      role: "user",
      content: [{ type: "text", text: "原始上下文" }, image],
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
    assert.deepEqual(projectPiHistory(history.open(a.id).getBranch()).messages[0]?.images, [
      { mimeType: image.mimeType, data: image.data },
    ]);
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
