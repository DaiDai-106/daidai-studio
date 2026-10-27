import assert from "node:assert/strict";
import { test } from "node:test";
import { type AssistantMessage, createModels, type Usage } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type {
  ConversationId,
  EntryId,
  EntryRecord,
  SnapshotEvent,
} from "@earendil-works/pi-durable";
import { createProjection } from "../../../src/backend/agent/projection.ts";
import { validateResult } from "../../../src/shared/application.ts";

function setup() {
  const models = createModels();
  const provider = builtinProviders().find((item) => item.id === "deepseek");
  assert.ok(provider);
  models.setProvider(provider);
  const model = models.getModels("deepseek")[0];
  assert.ok(model);
  return { models, model };
}
function usage(): Usage {
  return {
    input: 100,
    output: 50,
    cacheRead: 800,
    cacheWrite: 100,
    totalTokens: 1050,
    reasoning: 20,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
  };
}
function assistant(model: string, provider = "deepseek"): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    model,
    provider,
    responseModel: "actual-response-model",
    content: [{ type: "text", text: "Reply" }],
    usage: usage(),
    stopReason: "stop",
    timestamp: 1,
  };
}
function entry(message: AssistantMessage): EntryRecord {
  return {
    id: 1 as EntryId,
    conversationId: 1 as ConversationId,
    kind: "pi.assistant",
    model: [message],
  };
}
function snapshot(entries: EntryRecord[], message: AssistantMessage): SnapshotEvent {
  return {
    type: "snapshot",
    entries,
    tools: [],
    nestedTools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: { [`${message.provider}/${message.model}`]: message.usage }, tools: {} },
  };
}

test("usage projection restores actual model, cache counters and costs without counting events twice", () => {
  const { models, model } = setup();
  const message = assistant(model.id);
  const record = entry(message);
  const initial = snapshot([record], message);
  const projection = createProjection("1", models);
  const view = projection.apply([
    initial,
    { type: "entry_appended", entry: record },
    { type: "message_end", entry: record },
  ]);
  validateResult("conversation.watch", view);
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0]?.response?.model, "actual-response-model");
  assert.equal(view.latestResponse?.contextWindow, model.contextWindow);
  assert.deepEqual(view.usage, {
    input: 100,
    output: 50,
    cacheRead: 800,
    cacheWrite: 100,
    totalTokens: 1050,
    estimatedCostUsd: 0.37,
  });
  assert.equal(
    view.latestResponse?.usage.totalTokens,
    1050,
    "Reasoning is already part of output.",
  );
  const changed = projection.apply([
    {
      type: "usage_changed",
      usage: { models: { ...initial.usage.models, "compaction/model": message.usage }, tools: {} },
    },
  ]);
  assert.equal(
    changed.usage.totalTokens,
    2100,
    "Use the native ledger, including compaction spend.",
  );
  assert.equal(changed.latestResponse?.usage.totalTokens, 1050, "Context is not cumulative usage.");
  assert.equal(changed.usage.estimatedCostUsd, 0.74);
  assert.deepEqual(createProjection("1", models).apply([initial]).usage, view.usage);
});

test("unpriced responses never appear free, and model changes retain each reply identity", () => {
  const { models, model } = setup();
  const projection = createProjection("1", models);
  const first = assistant(model.id);
  const second = assistant("subscription-model", "custom");
  second.responseModel = "actual-subscription-model";
  second.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const next = { ...entry(second), id: 2 as EntryId };
  projection.apply([snapshot([entry(first)], first), { type: "message_start", message: second }]);
  assert.equal(projection.current().respondingModel, "actual-subscription-model");
  const view = projection.apply([
    { type: "message_end", entry: next },
    {
      type: "usage_changed",
      usage: {
        models: {
          [`deepseek/${model.id}`]: first.usage,
          "custom/subscription-model": second.usage,
        },
        tools: {},
      },
    },
    { type: "run_end", inputs: [] },
  ]);
  assert.equal(view.messages[0]?.response?.model, "actual-response-model");
  assert.equal(view.messages[1]?.response?.model, "actual-subscription-model");
  assert.equal(view.messages[1]?.response?.usage.estimatedCostUsd, null);
  assert.equal(view.usage.estimatedCostUsd, null);
  assert.equal(view.latestResponse?.contextWindow, null);
  assert.equal(view.respondingModel, null);
  const empty = projection.apply([{ ...snapshot([], second), usage: { models: {}, tools: {} } }]);
  assert.equal(empty.latestResponse, null);
  assert.equal(empty.usage.totalTokens, 0);
  validateResult("conversation.watch", empty);
});

function toolEntry(id: number, callId: string, content: string, isError = false): EntryRecord {
  return {
    id: id as EntryId,
    conversationId: 1 as ConversationId,
    kind: "pi.tool",
    model: [
      {
        role: "toolResult",
        toolCallId: callId,
        toolName: "read",
        content: [{ type: "text", text: content }],
        isError,
        timestamp: 20,
        durationMs: 15,
      },
    ],
  };
}

test("tool details retain arguments, stable identity, bounded output and stopped status across live and history", () => {
  const { models, model } = setup();
  const message = assistant(model.id);
  const args = {
    path: "/project/.daidai/artifacts/model/features.json",
    offset: 5,
    limit: 10,
    api_key: "secret",
  };
  message.content = [{ type: "toolCall", id: "read-call", name: "read", arguments: args }];
  message.stopReason = "toolUse";
  const projection = createProjection("1", models);
  projection.apply([{ type: "message_end", entry: entry(message) }]);
  let view = projection.apply([
    { type: "tool_execution_start", toolCallId: "read-call", toolName: "read", args },
    {
      type: "tool_execution_update",
      toolCallId: "read-call",
      toolName: "read",
      output: { set: "old" },
    },
    {
      type: "tool_execution_update",
      toolCallId: "read-call",
      toolName: "read",
      output: { trimStart: 1, append: "x" },
    },
  ]);
  assert.equal(view.activeTools[0]?.output, "ldx");
  assert.equal(view.activeTools[0]?.args?.path, args.path);
  assert.equal(view.activeTools[0]?.args?.api_key, "[已隐藏]");
  const key = view.activeTools[0]?.callKey;
  const record = toolEntry(2, "read-call", "x".repeat(9000));
  view = projection.apply([
    { type: "tool_execution_end", toolCallId: "read-call", toolName: "read", entry: record },
    { type: "entry_appended", entry: record },
  ]);
  assert.equal(view.activeTools.length, 0);
  assert.equal(view.messages.length, 2);
  assert.equal(view.messages[1]?.tool?.callKey, key);
  assert.equal(view.messages[1]?.text.length, 8000);
  assert.equal(view.messages[1]?.tool?.outputTruncated, true);
  validateResult("conversation.watch", view);
  const restored = createProjection("1", models).apply([
    snapshot([entry(message), record], message),
  ]);
  assert.deepEqual(restored.messages, view.messages);
  const next = {
    ...entry({
      ...message,
      content: [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "/new" } }],
    }),
    id: 3 as EntryId,
  };
  const stopped = {
    ...toolEntry(4, "read-call", "Request aborted", true),
    data: { diagnostics: [{ code: "aborted" }] },
  };
  view = projection.apply([
    { type: "entry_appended", entry: next },
    { type: "entry_appended", entry: stopped },
  ]);
  assert.equal(view.messages.at(-1)?.tool?.args?.path, "/new");
  assert.notEqual(
    view.messages.at(-1)?.tool?.callKey,
    key,
    "Reused provider call IDs belong to different assistant entries",
  );
  assert.equal(view.messages.at(-1)?.outcome, "stopped");
  assert.equal(view.messages[1]?.tool?.args?.path, args.path);
});

test("public thinking streams and restores without exposing redacted content or reasoning signatures", () => {
  const { models, model } = setup();
  const projection = createProjection("1", models);
  const message = { ...assistant(model.id), content: [] };
  let view = projection.apply([
    { type: "message_start", message },
    {
      type: "message_update",
      usage: usage(),
      changes: [
        {
          type: "thinking_start",
          contentIndex: 0,
          block: { type: "thinking", thinking: "", thinkingSignature: "private-signature" },
        },
        { type: "thinking_delta", contentIndex: 0, delta: "公开的思考摘要" },
        { type: "text_start", contentIndex: 1, block: { type: "text", text: "" } },
        { type: "text_delta", contentIndex: 1, delta: "最终回复" },
      ],
    },
  ]);
  assert.equal(view.partial, "最终回复");
  assert.equal(view.partialBlocks?.[0]?.text, "公开的思考摘要");
  assert.equal(JSON.stringify(view).includes("private-signature"), false);
  const final = assistant(model.id);
  final.content = [
    { type: "thinking", thinking: "公开的思考摘要", thinkingSignature: "private-signature" },
    {
      type: "thinking",
      thinking: "redacted-secret",
      redacted: true,
      thinkingSignature: "encrypted-secret",
    },
    { type: "text", text: "最终回复" },
  ];
  view = projection.apply([{ type: "message_end", entry: entry(final) }]);
  const restored = createProjection("1", models).apply([snapshot([entry(final)], final)]);
  assert.deepEqual(restored.messages, view.messages);
  assert.equal(JSON.stringify(restored).includes("secret"), false);
  assert.equal(JSON.stringify(restored).includes("signature"), false);
  validateResult("conversation.watch", restored);
  view = projection.apply([
    { type: "message_start", message },
    {
      type: "message_update",
      usage: usage(),
      changes: [
        {
          type: "thinking_start",
          contentIndex: 0,
          block: { type: "thinking", thinking: "secret", redacted: true },
        },
        { type: "thinking_delta", contentIndex: 0, delta: "still-secret" },
      ],
    },
  ]);
  assert.deepEqual(view.partialBlocks, []);
  view = projection.apply([{ type: "auto_retry_start", attempt: 2, at: 1, errorMessage: "retry" }]);
  assert.equal(view.activity, "retrying");
  assert.equal(view.partial, "");
  view = projection.apply([{ type: "run_end", inputs: [] }]);
  assert.equal(view.busy, false);
  assert.deepEqual(view.partialBlocks, []);
});

test("snapshot hydrates live tool details and thinking previews remain bounded", () => {
  const { models, model } = setup();
  const message = assistant(model.id);
  message.content = [
    { type: "toolCall", id: "call", name: "read", arguments: { path: "/absolute/path" } },
  ];
  const initial = snapshot([entry(message)], message);
  initial.run = { inputs: [] };
  initial.tools = [
    { callId: "call", name: "read", status: "running", output: "progress", droppedBytes: 100 },
  ];
  const projection = createProjection("1", models);
  let view = projection.apply([initial]);
  assert.equal(view.activeTools[0]?.args?.path, "/absolute/path");
  assert.equal(view.activeTools[0]?.output, "progress");
  assert.equal(view.activeTools[0]?.outputTruncated, true);
  assert.equal(view.activity, "tools");
  view = projection.apply([
    { type: "message_start", message: { ...message, content: [] } },
    {
      type: "message_update",
      usage: usage(),
      changes: [
        { type: "thinking_delta", contentIndex: 0, delta: "t".repeat(70_000) },
        { type: "thinking_delta", contentIndex: 0, delta: "more" },
      ],
    },
  ]);
  assert.equal(view.partialBlocks?.[0]?.text.length, 64_000);
  assert.equal(view.partialBlocks?.[0]?.truncated, true);
  validateResult("conversation.watch", view);
});

test("a reconnect snapshot replaces stale call/output/stream state and keeps subsequent completion idempotent", () => {
  const { models, model } = setup();
  const projection = createProjection("1", models);
  const old = assistant(model.id);
  old.content = [{ type: "toolCall", id: "call", name: "read", arguments: { path: "/old" } }];
  const initial = snapshot([entry(old)], old);
  initial.run = { inputs: [] };
  projection.apply([
    initial,
    { type: "tool_execution_start", toolCallId: "call", toolName: "read", args: { path: "/old" } },
    {
      type: "tool_execution_update",
      toolCallId: "call",
      toolName: "read",
      output: { set: "stale" },
    },
    {
      type: "message_start",
      message: { ...old, content: [{ type: "text", text: "stale reply" }] },
    },
  ]);
  const current = {
    ...old,
    content: [{ type: "toolCall" as const, id: "call", name: "read", arguments: { path: "/new" } }],
  };
  const record = { ...entry(current), id: 10 as EntryId };
  const reconnect = snapshot([record], current);
  reconnect.run = { inputs: [] };
  reconnect.tools = [{ callId: "call", name: "read", status: "running", output: "fresh" }];
  let view = projection.apply([reconnect]);
  assert.deepEqual(
    view.messages.map((item) => item.id),
    ["10:0"],
  );
  assert.equal(view.partial, "");
  assert.equal(view.activeTools[0]?.args?.path, "/new");
  assert.equal(view.activeTools[0]?.callKey, "10:call");
  view = projection.apply([
    {
      type: "tool_execution_update",
      toolCallId: "call",
      toolName: "read",
      output: { trimStart: 1, append: " tail" },
    },
  ]);
  assert.equal(view.activeTools[0]?.output, "resh tail");
  const finished = toolEntry(11, "call", "complete");
  view = projection.apply([
    { type: "tool_execution_end", toolCallId: "call", toolName: "read", entry: finished },
    { type: "entry_appended", entry: finished },
    { type: "run_end", inputs: [] },
  ]);
  assert.equal(view.messages.length, 2);
  assert.equal(view.messages[1]?.tool?.callKey, "10:call");
  assert.equal(view.messages[1]?.tool?.args?.path, "/new");
  assert.equal(view.activeTools.length, 0);
  assert.equal(view.busy, false);
  view.messages.length = 0;
  assert.equal(
    projection.current().messages.length,
    2,
    "Published views cannot mutate projection state",
  );
  validateResult("conversation.watch", projection.current());
});
