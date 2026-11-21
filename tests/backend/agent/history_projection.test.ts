import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHistoryProjection } from "../../../src/backend/agent/history_projection.ts";

test("长会话按 Pi 用户轮次分页，流式读取复用近期消息，分支切换淘汰旧索引", () => {
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
  assert.equal(baseline.history.markers.length, 2000);
  assert.equal(baseline.history.start, 1970);
  assert.equal(baseline.messages.length, 30);
  assert.match(baseline.messages[0]?.text ?? "", /^message-1970:/);
  assert.match(projection.firstUserText(session) ?? "", /^message-0:/);
  const boundary = baseline.history.markers[1970];
  const afterFirstPage = baseline.history.markers[30];
  assert.ok(boundary && afterFirstPage);
  const previous = projection.read(session, boundary.id, true);
  assert.equal(previous.start, 1940);
  assert.equal(previous.nextTurnId, boundary.id);
  assert.equal(previous.messages.length, 30);
  assert.match(previous.messages.at(-1)?.text ?? "", /^message-1969:/);
  const firstPage = projection.read(session, first, false);
  assert.equal(firstPage.start, 0);
  assert.equal(firstPage.nextTurnId, afterFirstPage.id);
  assert.equal(firstPage.messages[0]?.id, first);
  for (let i = 0; i < 1000; i++) assert.equal(projection.get(session).messages, baseline.messages);
  assert.equal(traversals, 1, "1000 次流式读取不应重复遍历 2000 条历史");
  session.appendMessage({ role: "user", content: "new", timestamp: 2001 });
  assert.equal(projection.get(session).history.markers.length, 2001);
  assert.equal(projection.get(session).messages.at(-1)?.text, "new");
  assert.equal(traversals, 2);
  session.branch(first);
  assert.equal(projection.get(session).messages.length, 1);
  assert.throws(() => projection.read(session, boundary.id, true), /当前分支/);
  assert.equal(traversals, 3);
  projection.clear();
  projection.get(session);
  assert.equal(traversals, 4);
});
