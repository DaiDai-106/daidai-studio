import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import type { ConversationView, MessageBlock } from "../../shared/application.ts";
import {
  displayArguments,
  preview,
  publicBlock,
  THINKING_PREVIEW_LIMIT,
  toolIdentity,
  toolPhase,
} from "./presentation.ts";
import { createMessageFormatter, emptyUsage } from "./projectionMessages.ts";
import type { ProjectedToolCall } from "./types.ts";

export function createProjection(
  conversationId: string,
  models: Pick<Models, "getModel" | "getModels">,
) {
  const formatter = createMessageFormatter(models);
  const calls = new Map<string, ProjectedToolCall>();
  const seen = new Set<number>();
  const outputWindows = new Map<string, string>();
  function rememberCalls(entry: EntryRecord) {
    for (const message of entry.model ?? [])
      if (message.role === "assistant")
        for (const block of message.content)
          if (block.type === "toolCall")
            calls.set(block.id, { args: block.arguments, key: `${entry.id}:${block.id}` });
  }
  let view: ConversationView = {
    conversationId,
    streamId: crypto.randomUUID(),
    sequence: 0,
    messages: [],
    partial: "",
    busy: false,
    error: "",
    usage: emptyUsage(),
    latestResponse: null,
    respondingModel: null,
    activeTools: [],
  };
  const live = new Map<number, MessageBlock | null>();
  function seed(message: AssistantMessage | undefined) {
    live.clear();
    view.partialHasToolCalls = false;
    message?.content.forEach((block, index) => {
      live.set(index, publicBlock(block));
      if (block.type === "toolCall") view.partialHasToolCalls = true;
    });
    syncPartial();
  }
  function syncPartial() {
    view.partialBlocks = [...live.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, block]) => (block ? [block] : []));
    view.partial = view.partialBlocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
  }
  function appendEntry(entry: EntryRecord) {
    if (seen.has(Number(entry.id))) return;
    seen.add(Number(entry.id));
    rememberCalls(entry);
    const items = formatter.entryMessages(entry, calls);
    const ids = new Set(view.messages.map((message) => message.id));
    view.messages.push(...items.filter((message) => !ids.has(message.id)));
    for (const item of items)
      if (item.tool?.callId) {
        view.activeTools = view.activeTools.filter((tool) => tool.id !== item.tool?.callId);
        outputWindows.delete(item.tool.callId);
      }
    for (const item of items)
      if (item.response && item.response.usage.totalTokens > 0) view.latestResponse = item.response;
  }
  function apply(events: readonly AgentEvent[]) {
    view.sequence++;
    for (const event of events) {
      switch (event.type) {
        case "snapshot": {
          calls.clear();
          seen.clear();
          outputWindows.clear();
          const messages = event.entries.flatMap((entry) => {
            seen.add(Number(entry.id));
            rememberCalls(entry);
            return formatter.entryMessages(entry, calls);
          });
          view = {
            ...view,
            messages,
            busy: !!event.run,
            error: "",
            usage: formatter.totalUsage(event.usage),
            latestResponse:
              [...messages]
                .reverse()
                .find((message) => (message.response?.usage.totalTokens ?? 0) > 0)?.response ??
              null,
            respondingModel:
              event.generation?.message?.responseModel || event.generation?.message?.model || null,
            activeTools: event.tools
              .filter((slot) => !slot.entry && slot.status !== "done")
              .map((slot) => {
                const output = slot.output ? preview(slot.output) : undefined;
                return {
                  id: slot.callId,
                  name: slot.name,
                  ...displayArguments(calls.get(slot.callId)?.args),
                  callKey: calls.get(slot.callId)?.key ?? slot.callId,
                  ...(output
                    ? {
                        output: output.text,
                        outputTruncated: output.truncated || !!slot.droppedBytes,
                      }
                    : {}),
                  phase: toolPhase(slot.details),
                  ...toolIdentity(slot.details),
                  status: slot.status === "pending" ? "pending" : "running",
                };
              }),
          };
          for (const slot of event.tools)
            if (slot.output) outputWindows.set(slot.callId, slot.output);
          seed(event.generation?.message);
          view.activity = event.compactions.some((item) => item.blocking)
            ? "compacting"
            : event.generation?.retry
              ? "retrying"
              : view.activeTools.length
                ? "tools"
                : view.partial
                  ? "responding"
                  : view.partialBlocks?.some((block) => block.kind === "thinking")
                    ? "thinking"
                    : "waiting";
          break;
        }
        case "message_start":
          if (event.message.role === "assistant") {
            seed(event.message);
            view.activity = "waiting";
            view.respondingModel = event.message.responseModel || event.message.model;
          }
          break;
        case "message_update":
          for (const change of event.changes) {
            if (change.type === "message") {
              view.respondingModel = change.message.responseModel || change.message.model;
              seed(change.message);
            } else if (change.type === "text_delta" || change.type === "thinking_delta") {
              const kind = change.type === "thinking_delta" ? "thinking" : "text";
              if (
                kind === "thinking" &&
                live.has(change.contentIndex) &&
                live.get(change.contentIndex) === null
              )
                continue;
              const previous = live.get(change.contentIndex);
              const value = preview(
                (previous?.text ?? "") + change.delta,
                kind === "thinking" ? THINKING_PREVIEW_LIMIT : 4_000_000,
              );
              live.set(change.contentIndex, {
                kind,
                text: value.text,
                truncated: value.truncated || !!previous?.truncated,
              });
              view.activity = kind === "thinking" ? "thinking" : "responding";
            } else if (
              change.type === "block" ||
              change.type === "text_start" ||
              change.type === "thinking_start" ||
              change.type === "toolcall_start"
            ) {
              live.set(change.contentIndex, publicBlock(change.block));
              if (change.block.type === "toolCall") view.partialHasToolCalls = true;
              view.activity =
                change.block.type === "thinking"
                  ? "thinking"
                  : change.block.type === "text"
                    ? "responding"
                    : "waiting";
            }
          }
          syncPartial();
          break;
        case "message_end":
        case "entry_appended": {
          appendEntry(event.entry);
          if (
            event.type === "message_end" &&
            event.entry.model?.some((message) => message.role === "assistant")
          ) {
            seed(undefined);
            view.activity = "waiting";
            view.respondingModel = null;
          }
          break;
        }
        case "run_start":
          view.busy = true;
          view.activity = "waiting";
          view.error = "";
          break;
        case "tool_execution_start":
          view.activeTools = view.activeTools.filter((tool) => tool.id !== event.toolCallId);
          view.activeTools.push({
            id: event.toolCallId,
            name: event.toolName,
            status: "running",
            phase: "",
            ...displayArguments(event.args),
            callKey: calls.get(event.toolCallId)?.key ?? event.toolCallId,
          });
          view.activity = "tools";
          break;
        case "tool_execution_update": {
          const tool = view.activeTools.find((item) => item.id === event.toolCallId);
          if (tool) {
            if (event.details !== undefined) {
              tool.phase = toolPhase(event.details);
              Object.assign(tool, toolIdentity(event.details));
            }
            if (event.output) {
              const output =
                "set" in event.output
                  ? event.output.set
                  : (outputWindows.get(tool.id) ?? "").slice(event.output.trimStart ?? 0) +
                    (event.output.append ?? "");
              outputWindows.set(tool.id, output);
              const shown = preview(output);
              tool.output = shown.text;
              tool.outputTruncated =
                !!tool.outputTruncated ||
                shown.truncated ||
                !!("trimStart" in event.output && event.output.trimStart);
            }
          }
          break;
        }
        case "tool_execution_end":
          view.activeTools = view.activeTools.filter((tool) => tool.id !== event.toolCallId);
          if (event.entry) appendEntry(event.entry);
          break;
        case "run_end":
          view.busy = false;
          seed(undefined);
          outputWindows.clear();
          view.activity = "waiting";
          view.respondingModel = null;
          view.activeTools = [];
          break;
        case "auto_retry_start":
          seed(undefined);
          view.activity = "retrying";
          break;
        case "auto_retry_end":
          view.activity = "waiting";
          break;
        case "compaction_start":
          view.activity = "compacting";
          break;
        case "compaction_end":
          view.activity = "waiting";
          break;
        case "submission":
          if (event.record.status === "unanswered") {
            const last = view.messages.at(-1);
            view.error =
              last?.role === "assistant" && last.failed
                ? last.text
                : "请求未完成，可检查服务配置后重新发送。";
            view.busy = false;
          }
          break;
        case "task_failed":
          view.error = "请求失败，请检查服务配置和认证。";
          break;
        case "usage_changed":
          view.usage = formatter.totalUsage(event.usage);
          break;
      }
    }
    return structuredClone(view);
  }
  return { apply, current: () => structuredClone(view) };
}
