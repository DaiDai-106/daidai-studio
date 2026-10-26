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
