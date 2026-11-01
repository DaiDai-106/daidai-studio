import assert from "node:assert/strict";
import { test } from "node:test";
import { displayArguments } from "../../src/backend/agent/presentation.ts";
import type { ConversationView, MessageInfo } from "../../src/contracts/application.ts";
import {
  completedTool,
  conversationTurns,
  finalReply,
  processItems,
  toolSummary,
} from "../../src/renderer/features/chat/logic/transcript.ts";

const message = (id: string, role: MessageInfo["role"], text: string): MessageInfo => ({
  id,
  role,
  text,
  failed: false,
});
test("completed viewport tool retains its evidence image for the details panel", () => {
  const image = { mimeType: "image/png" as const, data: "aGVsbG8=" };
  const tool = completedTool({
    ...message("view", "tool", '{"revision":3,"view":"+Z"}'),
    images: [image],
    tool: { name: "viewport_capture", args: { revision: 3, view: "+Z" }, durationMs: 5 },
  });
  assert.deepEqual(tool.images, [image]);
  assert.equal(tool.args?.revision, 3);
});
test("transcript groups each user request, retains commentary and selects only the final answer", () => {
  const turns = conversationTurns([
    message("1", "user", "read"),
    { ...message("2", "assistant", "Reading"), hasToolCalls: true },
    {
      ...message("3", "tool", "contents"),
      tool: { callKey: "2:call", name: "read", durationMs: 1 },
    },
    message("4", "assistant", "Done"),
    message("5", "user", "next"),
  ]);
  assert.equal(turns.length, 2);
  assert.ok(turns[0] && turns[1]);
  assert.equal(finalReply(turns[0])?.text, "Done");
  assert.deepEqual(
    processItems(turns[0], null).map((item) => item.kind),
    ["note", "tool"],
  );
  assert.equal(finalReply(turns[1]), undefined);
});
test("process row keys survive live thinking and tool completion", () => {
  const turn = { id: "1", messages: [] as MessageInfo[] };
  const stream = {
    partialBlocks: [{ kind: "thinking", text: "Think" }],
    activeTools: [{ id: "call", callKey: "2:call", name: "read", status: "running", phase: "" }],
  } as ConversationView;
  const before = processItems(turn, stream);
  turn.messages.push(
    {
      ...message("2", "assistant", ""),
      hasToolCalls: true,
      blocks: [{ kind: "thinking", text: "Think" }],
    },
    { ...message("3", "tool", "done"), tool: { name: "read", callKey: "2:call", durationMs: 1 } },
  );
  assert.deepEqual(
    processItems(turn, null).map((item) => item.key),
    before.map((item) => item.key),
  );
});
test("read summaries handle Windows and Linux paths without changing execution arguments", () => {
  assert.equal(
    toolSummary("read", { path: "C:\\project\\features.json", offset: 20, limit: 50 }),
    "features.json · 从第 20 行起，最多 50 行",
  );
  assert.equal(toolSummary("read", { path: "/project/model.json" }), "model.json · 从第 1 行起");
  assert.equal(toolSummary("unknown", undefined), "");
  const args = {
    path: "/actual/path",
    nested: { access_token: "secret" },
    payload: "x".repeat(5000),
  };
  const result = displayArguments(args);
  assert.equal(
    (result.args?.nested as Record<string, unknown> | undefined)?.access_token,
    "[已隐藏]",
  );
  assert.equal(result.argsTruncated, true);
  assert.equal(args.nested.access_token, "secret");
});
