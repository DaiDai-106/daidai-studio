import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHistoryProjection } from "../../../src/backend/agent/history_projection.ts";

test("长会话连续读取只投影一次；追加、切换分支和模型重配置会失效", () => {
  const session = SessionManager.inMemory();
  let first = "";
  for (let i = 0; i < 2000; i++) {
    const id = session.appendMessage({
      role: "user",
      content: `message-${i}: ${"x".repeat(128)}`,
      timestamp: i,
    });
    first ||= id;
  }
  let traversals = 0;
  const original = session.getBranch.bind(session);
  session.getBranch = (...args) => {
    ++traversals;
    return original(...args);
  };
  const projection = createHistoryProjection(() => undefined);
  const baseline = projection.get(session);
  for (let i = 0; i < 1000; i++) assert.equal(projection.get(session).messages, baseline.messages);
  assert.equal(traversals, 1, "1000 次流式读取不应重复遍历 2000 条历史");
  session.appendMessage({ role: "user", content: "new", timestamp: 2001 });
  assert.equal(projection.get(session).messages.length, 2001);
  assert.equal(traversals, 2);
  session.branch(first);
  assert.equal(projection.get(session).messages.length, 1);
  assert.equal(traversals, 3);
  projection.clear();
  projection.get(session);
  assert.equal(traversals, 4);
});
