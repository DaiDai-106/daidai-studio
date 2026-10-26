import type { AssistantMessage, Message, Models, Usage } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, UsageState } from "@earendil-works/pi-durable";
import type {
  ConversationView,
  MessageInfo,
  ResponseInfo,
  UsageInfo,
} from "../../shared/application.ts";
import { modelRequestError } from "./errors.ts";

function toolPhase(details: unknown): string {
  if (
    !details ||
    typeof details !== "object" ||
    !("phase" in details) ||
    typeof details.phase !== "string"
  )
    return "";
  return details.phase.slice(0, 200);
}

function toolIdentity(details: unknown): { displayName?: string; serverName?: string } {
  if (
    !details ||
    typeof details !== "object" ||
    !("toolName" in details) ||
    !("serverName" in details) ||
    typeof details.toolName !== "string" ||
    typeof details.serverName !== "string"
  )
    return {};
  return {
    displayName: details.toolName.slice(0, 200),
    serverName: details.serverName.slice(0, 200),
  };
}

function usageInfo(usage: Usage, priced: boolean): UsageInfo {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    // Pi's zero-price placeholder also covers subscriptions and unknown pricing.
    estimatedCostUsd:
      priced || usage.cost.total > 0 || usage.totalTokens === 0 ? usage.cost.total : null,
  };
}

function emptyUsage(): UsageInfo {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, estimatedCostUsd: 0 };
}

function text(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}
export function createProjection(
  conversationId: string,
  models: Pick<Models, "getModel" | "getModels">,
) {
  function responseInfo(message: AssistantMessage): ResponseInfo {
    const model = models.getModel(message.provider, message.model);
    return {
      model: message.responseModel || message.model,
      provider: message.provider,
      contextWindow: model?.contextWindow ?? null,
      usage: usageInfo(
        message.usage,
        !!model &&
          Object.values(model.cost).some((price) => typeof price === "number" && price > 0),
      ),
    };
  }
  function totalUsage(state: UsageState): UsageInfo {
    const total = emptyUsage();
    const catalog = models.getModels();
    for (const [key, usage] of Object.entries(state.models)) {
      const model = catalog.find((item) => `${item.provider}/${item.id}` === key);
      const item = usageInfo(
        usage,
        !!model &&
          Object.values(model.cost).some((price) => typeof price === "number" && price > 0),
      );
      total.input += item.input;
      total.output += item.output;
      total.cacheRead += item.cacheRead;
      total.cacheWrite += item.cacheWrite;
      total.totalTokens += item.totalTokens;
      total.estimatedCostUsd =
        total.estimatedCostUsd === null || item.estimatedCostUsd === null
          ? null
          : total.estimatedCostUsd + item.estimatedCostUsd;
    }
    return total;
  }
  function entryMessages(entry: EntryRecord): MessageInfo[] {
    return (entry.model ?? []).flatMap<MessageInfo>((message, index) => {
      if (message.role === "toolResult")
        return [
          {
            id: `${entry.id}:${index}`,
            role: "tool" as const,
            text: text(message).slice(0, 4000),
            failed: message.isError,
            tool: {
              name: message.toolName,
              durationMs: message.durationMs ?? null,
              ...toolIdentity(message.details),
            },
          },
        ];
      if (message.role !== "user" && message.role !== "assistant") return [];
      const failed =
        message.role === "assistant" && ["error", "aborted"].includes(message.stopReason);
      let content = text(message);
      if (failed && message.role === "assistant")
        content =
          message.stopReason === "aborted"
            ? "请求已停止。"
            : modelRequestError(message.errorMessage);
      return [
        {
          id: `${entry.id}:${index}`,
          role: message.role,
          text: content,
          failed,
          ...(message.role === "assistant" ? { response: responseInfo(message) } : {}),
        },
      ];
    });
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
  const partial = new Map<number, string>();
  function appendEntry(entry: EntryRecord) {
    const items = entryMessages(entry);
    const ids = new Set(view.messages.map((message) => message.id));
    view.messages.push(...items.filter((message) => !ids.has(message.id)));
    for (const item of items)
      if (item.response && item.response.usage.totalTokens > 0) view.latestResponse = item.response;
  }
  function apply(events: readonly AgentEvent[]) {
    view.sequence++;
    for (const event of events) {
      switch (event.type) {
        case "snapshot": {
          const messages = event.entries.flatMap(entryMessages);
          view = {
            ...view,
            messages,
            partial: event.generation?.message ? text(event.generation.message) : "",
            busy: !!event.run,
            error: "",
            usage: totalUsage(event.usage),
            latestResponse:
              [...messages]
                .reverse()
                .find((message) => (message.response?.usage.totalTokens ?? 0) > 0)?.response ??
              null,
            respondingModel:
              event.generation?.message?.responseModel || event.generation?.message?.model || null,
            activeTools: event.tools
              .filter((slot) => !slot.entry && slot.status !== "done")
              .map((slot) => ({
                id: slot.callId,
                name: slot.name,
                phase: toolPhase(slot.details),
                ...toolIdentity(slot.details),
                status: slot.status === "pending" ? "pending" : "running",
              })),
          };
          partial.clear();
          if (event.generation?.message)
            event.generation.message.content.forEach((block, index) => {
              if (block.type === "text") partial.set(index, block.text);
            });
          break;
        }
        case "message_start":
          if (event.message.role === "assistant") {
            partial.clear();
            view.partial = text(event.message);
            view.respondingModel = event.message.responseModel || event.message.model;
          }
          break;
        case "message_update":
          for (const change of event.changes) {
            if (change.type === "text_start")
              partial.set(
                change.contentIndex,
                change.block.type === "text" ? change.block.text : "",
              );
            else if (change.type === "text_delta")
              partial.set(
                change.contentIndex,
                (partial.get(change.contentIndex) ?? "") + change.delta,
              );
            else if (change.type === "block" && change.block.type === "text")
              partial.set(change.contentIndex, change.block.text);
            else if (change.type === "message") {
              view.respondingModel = change.message.responseModel || change.message.model;
              partial.clear();
              change.message.content.forEach((block, index) => {
                if (block.type === "text") partial.set(index, block.text);
              });
            }
          }
          view.partial = [...partial.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, value]) => value)
            .join("");
          break;
        case "message_end":
        case "entry_appended": {
          appendEntry(event.entry);
          if (
            event.type === "message_end" &&
            event.entry.model?.some((message) => message.role === "assistant")
          ) {
            partial.clear();
            view.partial = "";
            view.respondingModel = null;
          }
          break;
        }
        case "run_start":
          view.busy = true;
          view.error = "";
          break;
        case "tool_execution_start":
          view.activeTools = view.activeTools.filter((tool) => tool.id !== event.toolCallId);
          view.activeTools.push({
            id: event.toolCallId,
            name: event.toolName,
            status: "running",
            phase: "",
          });
          break;
        case "tool_execution_update": {
          const tool = view.activeTools.find((item) => item.id === event.toolCallId);
          if (tool && event.details !== undefined) {
            tool.phase = toolPhase(event.details);
            Object.assign(tool, toolIdentity(event.details));
          }
          break;
        }
        case "tool_execution_end":
          view.activeTools = view.activeTools.filter((tool) => tool.id !== event.toolCallId);
          if (event.entry) appendEntry(event.entry);
          break;
        case "run_end":
          view.busy = false;
          view.partial = "";
          view.respondingModel = null;
          view.activeTools = [];
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
          view.usage = totalUsage(event.usage);
          break;
      }
    }
    return structuredClone(view);
  }
  return { apply, current: () => structuredClone(view) };
}
