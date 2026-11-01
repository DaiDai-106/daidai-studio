import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { createShellApproval } from "../../../src/backend/agent/shellApproval.ts";
import type { ApplicationEvent } from "../../../src/contracts/application.ts";

test("shell approvals queue across chats and cancelling one does not approve another", async () => {
  const events: ApplicationEvent[] = [];
  const approval = createShellApproval((event) => events.push(event));
  let handler!: (event: ToolCallEvent, context: ExtensionContext) => Promise<unknown>;
  const pi = {
    on: (_event: string, callback: typeof handler) => {
      handler = callback;
    },
  } as unknown as ExtensionAPI;
  await approval.extension("chat-a")(pi);
  const controller = new AbortController();
  const context = { cwd: "/workspace", signal: controller.signal } as ExtensionContext;
  const event = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "call",
    input: { command: "touch first" },
  } as ToolCallEvent;
  const first = handler(event, context);
  const firstId = approval.pending()?.id;
  assert.ok(firstId);
  await approval.extension("chat-b")(pi);
  const second = handler({ ...event, toolCallId: "second" }, { ...context, signal: undefined });
  assert.equal(approval.pending()?.conversationId, "chat-a");
  controller.abort();
  assert.deepEqual(await first, { block: true, reason: "命令已取消。" });
  assert.equal(approval.pending()?.conversationId, "chat-b");
  assert.throws(() => approval.respond(firstId, true), /失效/);
  approval.respond(approval.pending()?.id ?? "", false);
  assert.deepEqual(await second, { block: true, reason: "用户拒绝执行此命令。" });
  assert.equal(approval.pending(), null);
  assert.ok(events.some((item) => item.type === "shell.approval" && item.approval === null));
  approval.close();
});
