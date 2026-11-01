import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPiHistory } from "../../../src/backend/agent/piHistory.ts";
import { projectPiHistory } from "../../../src/backend/agent/piProjection.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";

test("Pi history restores images, thinking, tool results and real usage after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-pi-projection-"));
  const data = join(root, "data");
  try {
    let store = openProjectStore(data);
    const project = store.createProject({ name: "Scene", mode: "scene", path: root });
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
