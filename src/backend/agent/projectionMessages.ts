import type { AssistantMessage, Message, Models, Usage } from "@earendil-works/pi-ai";
import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";
import type { MessageInfo, ResponseInfo, UsageInfo } from "../../shared/application.ts";
import { modelRequestError } from "./errors.ts";
import { displayArguments, preview, publicBlock, toolIdentity } from "./presentation.ts";
import type { ProjectedToolCall } from "./types.ts";

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

export function emptyUsage(): UsageInfo {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, estimatedCostUsd: 0 };
}

export function messageText(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}
// Formats committed entries; call identity and event state remain owned by createProjection.
export function createMessageFormatter(models: Pick<Models, "getModel" | "getModels">) {
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
  function stopped(entry: EntryRecord) {
    const data = entry.data;
    return (
      !!data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      Array.isArray(data.diagnostics) &&
      data.diagnostics.some(
        (item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          (item.code === "aborted" || item.code === "abandoned"),
      )
    );
  }
  function entryMessages(
    entry: EntryRecord,
    calls: ReadonlyMap<string, ProjectedToolCall>,
  ): MessageInfo[] {
    return (entry.model ?? []).flatMap<MessageInfo>((message, index) => {
      if (message.role === "toolResult") {
        const output = preview(messageText(message));
        return [
          {
            id: `${entry.id}:${index}`,
            role: "tool" as const,
            text: output.text,
            timestamp: message.timestamp,
            outcome: stopped(entry) ? "stopped" : message.isError ? "failed" : "completed",
            failed: message.isError,
            tool: {
              name: message.toolName,
              callId: message.toolCallId,
              ...displayArguments(calls.get(message.toolCallId)?.args),
              callKey:
                calls.get(message.toolCallId)?.key ?? `tool:${entry.id}:${message.toolCallId}`,
              outputTruncated: output.truncated,
              durationMs: message.durationMs ?? null,
              ...toolIdentity(message.details),
            },
          },
        ];
      }
      if (message.role !== "user" && message.role !== "assistant") return [];
      const failed =
        message.role === "assistant" && ["error", "aborted"].includes(message.stopReason);
      let content = messageText(message);
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
          ...(message.role === "user" && Array.isArray(message.content)
            ? {
                images: message.content
                  .filter((block) => block.type === "image")
                  .map(({ data, mimeType }) => ({
                    data,
                    mimeType: mimeType as "image/png" | "image/jpeg" | "image/webp",
                  })),
              }
            : {}),
          failed,
          timestamp: message.timestamp,
          ...(message.role === "assistant"
            ? {
                response: responseInfo(message),
                blocks: message.content.flatMap((block) => {
                  const value = publicBlock(block);
                  return value ? [value] : [];
                }),
                hasToolCalls: message.content.some((block) => block.type === "toolCall"),
                outcome:
                  message.stopReason === "aborted" ? "stopped" : failed ? "failed" : "completed",
                ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
              }
            : {}),
        },
      ];
    });
  }
  return { entryMessages, totalUsage };
}
