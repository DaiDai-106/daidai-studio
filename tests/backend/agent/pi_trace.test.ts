import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectTrace, traceDetail } from "../../../src/backend/agent/pi_trace.ts";
import { validateResult } from "../../../src/contracts/application.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function reply(session: SessionManager, text = "回答") {
  return session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 10,
    provider: "fixture",
    model: "model",
    api: "openai-completions",
    stopReason: "stop",
    usage,
  });
}
const tool = (name: string) => ({
  name,
  description: `${name} definition`,
  parameters: {
    type: "object",
    properties: { url: { type: "string" }, token: { type: "string" } },
  },
});

test("按每次响应恢复系统段与工具增删，用户行包含本轮后置注入，原始历史不变", () => {
  const session = SessionManager.inMemory();
  session.appendMessage({
    role: "system",
    content: "base prompt",
    sections: { preamble: "initial" },
    toolsAdded: [tool("read")],
    timestamp: 1,
  });
  const user = session.appendMessage({ role: "user", content: "first request", timestamp: 2 });
  session.appendMessage({
    role: "system",
    content: "",
    sections: { ponytail: "PONYTAIL MODE ACTIVE — level: full" },
    timestamp: 3,
  });
  const first = reply(session);
  session.appendMessage({
    role: "system",
    content: "",
    toolsAdded: [tool("fetch_content")],
    timestamp: 4,
  });
  const second = reply(session);
  session.appendMessage({ role: "user", content: "second request", timestamp: 5 });
  session.appendMessage({
    role: "system",
    content: "",
    sections: { ponytail: null, preamble: "updated" },
    toolsRemoved: [{ name: "fetch_content" }],
    toolsAdded: [tool("bash")],
    timestamp: 6,
  });
  const third = reply(session);
  const branch = session.getBranch();
  const before = JSON.stringify(branch);
  const a = traceDetail(branch, first).context;
  assert.ok(a?.content.includes("PONYTAIL MODE ACTIVE"));
  assert.deepEqual(
    a?.tools.map((t) => t.name),
    ["read"],
  );
  assert.equal(JSON.parse(a?.tools[0]?.parameters ?? "{}").properties.token.type, "string");
  assert.deepEqual(traceDetail(branch, user).context, a);
  assert.deepEqual(
    traceDetail(branch, second).context?.tools.map((t) => t.name),
    ["read", "fetch_content"],
  );
  const b = traceDetail(branch, third).context;
  assert.deepEqual(
    b?.tools.map((t) => t.name),
    ["read", "bash"],
  );
  assert.ok(!b?.sections.some((s) => s.name === "ponytail"));
  assert.ok(b?.content.includes("updated"));
  const records = projectTrace(branch);
  assert.deepEqual(
    records.map((r) => r.role),
    ["system", "user", "system", "assistant", "system", "assistant", "user", "system", "assistant"],
  );
  assert.equal(records.at(-1)?.turn, 2);
  validateResult("conversation.trace", records);
  for (const record of records)
    validateResult("conversation.traceDetail", traceDetail(branch, record.id));
  assert.equal(JSON.stringify(branch), before, "查看轨迹不能修改 SDK 历史或工具选择");
});

test("调用参数复用脱敏，长结果按需读取，保留结构化错误，不暴露隐藏思考", () => {
  const session = SessionManager.inMemory();
  const assistant = session.appendMessage({
    role: "assistant",
    timestamp: 1,
    provider: "fixture",
    model: "model",
    api: "openai-completions",
    stopReason: "toolUse",
    usage,
    content: [
      { type: "thinking", thinking: "hidden thought", redacted: true },
      {
        type: "toolCall",
        id: "fetch-1",
        name: "fetch_content",
        arguments: { url: "https://example.com", nested: { api_key: "private-key" } },
      },
    ],
  });
  const result = session.appendMessage({
    role: "toolResult",
    toolCallId: "fetch-1",
    toolName: "fetch_content",
    content: [{ type: "text", text: `${"x".repeat(10_000)} END OF RESULT` }],
    isError: true,
    details: { error: "network blocked", token: "private-token" },
    timestamp: 2,
  });
  const branch = session.getBranch();
  const before = JSON.stringify(branch);
  const records = projectTrace(branch);
  assert.equal(records[1]?.failed, true);
  assert.ok((records[1]?.preview.length ?? 0) <= 500);
  const call = traceDetail(branch, assistant);
  assert.equal(call.text, "");
  assert.deepEqual(call.calls[0]?.args?.nested, { api_key: "[已隐藏]" });
  const detail = traceDetail(branch, result);
  assert.match(detail.text, /END OF RESULT/);
  assert.match(detail.text, /network blocked/);
  assert.ok(!detail.text.includes("private-token"));
  assert.deepEqual(detail.tool?.args?.nested, { api_key: "[已隐藏]" });
  assert.equal(JSON.stringify(branch), before);
  assert.ok(!JSON.stringify(records).includes("hidden thought"));
  validateResult("conversation.traceDetail", detail);
});

test("压缩后的请求使用 SDK 检查点，分支只显示自己的记录，缺失系统不伪造", () => {
  const session = SessionManager.inMemory();
  session.appendMessage({
    role: "system",
    content: "original system",
    sections: { ponytail: "full" },
    toolsAdded: [tool("read")],
    timestamp: 1,
  });
  const first = session.appendMessage({ role: "user", content: "old user", timestamp: 2 });
  const oldResponse = reply(session);
  const compact = session.appendCompaction("compacted summary", null, 1000);
  session.appendMessage({ role: "user", content: "after compaction", timestamp: 3 });
  const after = reply(session);
  const state = traceDetail(session.getBranch(), after).context;
  assert.equal(state?.recorded, true);
  assert.ok(state?.content.includes("original system"));
  assert.equal(projectTrace(session.getBranch()).find((r) => r.id === compact)?.role, "event");
  session.branch(first);
  const fork = reply(session, "fork reply");
  assert.ok(!projectTrace(session.getBranch()).some((r) => r.id === after));
  assert.throws(() => traceDetail(session.getBranch(), after), /当前分支/);
  assert.ok(traceDetail(session.getBranch(), fork).context?.content.includes("original system"));
  assert.throws(() => traceDetail(session.getBranch(), oldResponse), /当前分支/);
});

test("旧历史没有系统记录时明确缺失，超长正文有截断标识", () => {
  const session = SessionManager.inMemory();
  const id = reply(session, "x".repeat(4_000_001));
  const detail = traceDetail(session.getBranch(), id);
  assert.equal(detail.context?.recorded, false);
  assert.equal(detail.text.length, 4_000_000);
  assert.equal(detail.truncated, true);
  validateResult("conversation.traceDetail", detail);
});

test("聊天隐藏的扩展指令仍可从轨迹和本轮上下文检查，压缩后遵循 SDK 保留范围", () => {
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "system", content: "base", timestamp: 1 });
  session.appendMessage({ role: "user", content: "task", timestamp: 2 });
  const injection = session.appendCustomMessageEntry(
    "runtime-rules",
    "hidden plugin instructions",
    false,
  );
  const response = reply(session);
  const records = projectTrace(session.getBranch());
  assert.match(records.find((record) => record.id === injection)?.label ?? "", /插件注入/);
  assert.equal(traceDetail(session.getBranch(), injection).text, "hidden plugin instructions");
  assert.equal(
    traceDetail(session.getBranch(), response).context?.injections[0]?.text,
    "hidden plugin instructions",
  );
  session.appendCompaction("summary replaces old messages", null, 100);
  const later = reply(session);
  assert.deepEqual(traceDetail(session.getBranch(), later).context?.injections, []);
});
