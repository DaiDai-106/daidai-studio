import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  ChatImageSchema,
  type ConversationView,
  type MessageInfo,
  type ResponseInfo,
} from "../../contracts/application.ts";
import { displayArguments } from "./presentation.ts";

type ModelContext = (
  provider: string,
  model: string,
) =>
  | {
      contextWindow: number;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    }
  | undefined;
type Usage = ConversationView["usage"];

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  estimatedCostUsd: null,
});
const count = (value: number) => (Number.isFinite(value) && value >= 0 ? value : 0);

/** 从 Pi 原生历史投影界面；聊天历史仍由 SessionManager 保存。 */
export function projectPiHistory(
  entries: SessionEntry[],
  modelContext: ModelContext = () => undefined,
) {
  const messages: MessageInfo[] = [];
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const usage = emptyUsage();
  let latestResponse: ResponseInfo | null = null;
  let knownTotalCost = true;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      const content =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content;

      const text = content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
        .slice(0, 4_000_000);
      const images = content
        .flatMap((part) => {
          if (part.type !== "image") return [];
          const value = { data: part.data, mimeType: part.mimeType };
          return Value.Check(ChatImageSchema, value) ? [value] : [];
        })
        .slice(0, 3);

      messages.push({
        id: entry.id,
        role: "user",
        text,
        ...(images.length ? { images } : {}),
        failed: false,
        timestamp: message.timestamp,
      });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: NonNullable<MessageInfo["blocks"]> = [];
      for (const part of message.content) {
        if (part.type === "text")
          blocks.push({ kind: "text", text: part.text.slice(0, 4_000_000) });
        else if (part.type === "thinking" && !part.redacted)
          blocks.push({ kind: "thinking", text: part.thinking.slice(0, 4_000_000) });
        else if (part.type === "toolCall")
          calls.set(part.id, { name: part.name, args: { ...part.arguments } });
      }

      const tokens = message.usage;
      const model = modelContext(message.provider, message.model);
      const priceKnown = model && Object.values(model.cost).some((value) => value > 0);
      const totalCost = tokens.cost.total;
      const responseUsage: Usage = {
        input: count(tokens.input),
        output: count(tokens.output),
        cacheRead: count(tokens.cacheRead),
        cacheWrite: count(tokens.cacheWrite),
        totalTokens: count(tokens.totalTokens),
        estimatedCostUsd:
          Number.isFinite(totalCost) && totalCost >= 0 && (totalCost > 0 || priceKnown)
            ? totalCost
            : null,
      };

      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
        usage[key] += responseUsage[key];
      if (responseUsage.estimatedCostUsd === null) {
        knownTotalCost = false;
        usage.estimatedCostUsd = null;
      } else if (knownTotalCost) {
        usage.estimatedCostUsd = (usage.estimatedCostUsd ?? 0) + responseUsage.estimatedCostUsd;
      }
      latestResponse = {
        model: message.model.slice(0, 500),
        provider: message.provider.slice(0, 200),
        contextWindow: model?.contextWindow ?? null,
        usage: responseUsage,
      };

      const failed = message.stopReason === "error" || message.stopReason === "aborted";
      const text =
        blocks
          .filter((block) => block.kind === "text")
          .map((block) => block.text)
          .join("")
          .slice(0, 4_000_000) ||
        (failed
          ? message.stopReason === "aborted"
            ? "请求已停止。"
            : "模型请求失败，请检查模型服务配置。"
          : "");
      messages.push({
        id: entry.id,
        role: "assistant",
        text,
        failed,
        timestamp: message.timestamp,
        response: latestResponse,
        blocks,
        hasToolCalls: message.content.some((part) => part.type === "toolCall"),
        outcome: message.stopReason === "aborted" ? "stopped" : failed ? "failed" : "completed",
        ...(message.durationMs === undefined ? {} : { durationMs: count(message.durationMs) }),
      });
      continue;
    }
    if (message.role === "toolResult") {
      const text = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      const call = calls.get(message.toolCallId);
      messages.push({
        id: entry.id,
        role: "tool",
        text: text.slice(0, 8000),
        failed: message.isError,
        timestamp: message.timestamp,
        outcome: message.isError ? "failed" : "completed",
        tool: {
          name: message.toolName.slice(0, 200),
          callId: message.toolCallId.slice(0, 1000),
          ...(call ? displayArguments(call.args) : {}),
          outputTruncated: text.length > 8000,
          durationMs: message.durationMs === undefined ? null : count(message.durationMs),
        },
      });
    }
  }
  return { messages, usage, latestResponse };
}
