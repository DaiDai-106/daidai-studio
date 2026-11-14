import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHistoryProjection } from "../../../src/backend/agent/history_projection.ts";
import { createPiHistory } from "../../../src/backend/agent/pi_history.ts";
import { projectPiHistory } from "../../../src/backend/agent/pi_projection.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";

test("Pi history restores images, thinking, tool results and real usage after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-pi-projection-"));
  const data = join(root, "data");
  try {
    let store = openProjectStore(data);
    const project = store.createProject({ name: "Scene", mode: "coding", path: root });
    const chat = store.createConversation(project.id);
    let history = createPiHistory(store, data);
    const session = history.open(chat.id);
    session.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "消息" },
        { type: "image", mimeType: "image/png", data: "YQ==" },
      ],
      timestamp: 1,
    });
    session.appendMessage({
      role: "assistant",
      api: "openai-completions",
      provider: "local",
      model: "example",
      timestamp: 2,
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "思路" },
        { type: "text", text: "开始" },
        {
          type: "toolCall",
          id: "call-1",
          name: "scene_get",
          arguments: {
            project: "p",
            nested: { access_token: "private-value" },
            text: "x".repeat(5000),
          },
        },
      ],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
      },
    });
    session.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "scene_get",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 3,
    });
    store.close();
    store = openProjectStore(data);
    history = createPiHistory(store, data);
    const restoredSession = history.open(chat.id);
    const projected = projectPiHistory(restoredSession.getBranch(), () => ({
      contextWindow: 4096,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    }));
    assert.equal(projected.messages.length, 3);
    assert.deepEqual(projected.messages[0]?.images, [{ mimeType: "image/png", data: "YQ==" }]);
    assert.deepEqual(projected.messages[1]?.blocks, [
      { kind: "thinking", text: "思路" },
      { kind: "text", text: "开始" },
    ]);
    assert.equal(projected.messages[1]?.hasToolCalls, true);
    const args = projected.messages[2]?.tool?.args;
    assert.equal(args?.project, "p");
    assert.deepEqual(args?.nested, { access_token: "[已隐藏]" });
    assert.equal(typeof args?.text, "string");
    assert.equal((args?.text as string | undefined)?.length, 4096);
    assert.equal(projected.messages[2]?.tool?.argsTruncated, true);
    const original = restoredSession
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant");
    assert.ok(original && original.type === "message" && original.message.role === "assistant");
    const call = original.message.content.find((part) => part.type === "toolCall");
    assert.equal(
      call?.type === "toolCall" && (call.arguments.nested as { access_token: string }).access_token,
      "private-value",
    );
    assert.equal(projected.messages[2]?.text, "result");
    assert.equal(projected.usage.input, 10);
    assert.equal(projected.usage.estimatedCostUsd, 0.1);
    assert.equal(projected.latestResponse?.contextWindow, 4096);
    restoredSession.appendMessage({
      role: "assistant",
      api: "openai-completions",
      provider: "unknown",
      model: "other",
      timestamp: 4,
      stopReason: "stop",
      content: [{ type: "text", text: "完成" }],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const mixed = projectPiHistory(restoredSession.getBranch());
    assert.equal(mixed.latestResponse?.usage.estimatedCostUsd, null);
    assert.equal(mixed.usage.estimatedCostUsd, null);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("原生摘要与可见扩展消息显示，隐藏消息和扩展状态不泄露", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "system", content: "不展示的系统指令", timestamp: 0 });
  const first = manager.appendMessage({ role: "user", content: "保留旧消息", timestamp: 1 });
  manager.appendCompaction("压缩后的说明", first, 100);
  const leaf = manager.getLeafId();
  assert.ok(leaf);
  manager.branchWithSummary(leaf, "分支的说明");
  manager.appendCustomMessageEntry(
    "review",
    [
      { type: "text", text: "可见扩展说明" },
      { type: "image", data: "YQ==", mimeType: "image/png" },
    ],
    true,
  );
  manager.appendCustomMessageEntry("hidden", "隐藏扩展说明", false);
  manager.appendCustomEntry("private-state", { secret: "不得显示" });
  const { messages } = projectPiHistory(manager.getBranch());
  assert.equal(messages[0]?.text, "保留旧消息");
  assert.ok(messages.every((item) => !item.text.includes("不展示的系统指令")));
  assert.deepEqual(messages.find((item) => item.eventLabel === "review")?.images, [
    { data: "YQ==", mimeType: "image/png" },
  ]);
  assert.deepEqual(
    messages.filter((item) => item.role === "event").map((item) => [item.eventLabel, item.text]),
    [
      ["上下文压缩摘要", "压缩后的说明"],
      ["分支摘要", "分支的说明"],
      ["review", "可见扩展说明"],
    ],
  );
});

test("累计统计覆盖其他分支、摘要、工具及独立用量，恢复后与当前分支区分", () => {
  const manager = SessionManager.inMemory();
  const usage = {
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 1,
    totalTokens: 16,
    cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
  };
  const first = manager.appendMessage({ role: "user", content: "原始消息", timestamp: 1 });
  manager.appendUsage("cache_warm", "fixture", "model", usage);
  manager.appendCompaction("摘要", first, 16, undefined, false, usage);
  manager.appendMessage({
    role: "toolResult",
    toolName: "fixture",
    toolCallId: "call",
    content: [],
    isError: false,
    timestamp: 2,
    usage,
  });
  manager.branch(first);
  manager.appendUsage("cache_warm", "fixture", "model", usage);
  const projection = createHistoryProjection(() => ({
    contextWindow: 1000,
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  }));
  const restored = projection.get(manager);
  assert.equal(restored.usage.totalTokens, 64);
  assert.equal(restored.branchUsage.totalTokens, 16);
  assert.equal(restored.usage.estimatedCostUsd, 0.4);
  assert.equal(restored.messages.length, 1);
  const stats = {
    sessionId: manager.getSessionId(),
    sessionFile: undefined,
    userMessages: 1,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 1,
    totalMessages: 2,
    tokens: { input: 40, output: 8, cacheRead: 12, cacheWrite: 4, total: 64 },
    cost: 0.4,
  };
  projection.clear();
  let calls = 0;
  assert.deepEqual(
    projection.get(manager, () => {
      calls++;
      return stats;
    }).usage,
    restored.usage,
  );
  projection.get(manager, () => {
    calls++;
    return stats;
  });
  assert.equal(calls, 1);
});
