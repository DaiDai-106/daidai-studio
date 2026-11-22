import { contentText, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  ChatImageSchema,
  type MessageInfo,
  type ResponseInfo,
} from "../../contracts/application.ts";
import { splitStepMessage } from "../../shared/step_attachment.ts";
import { type ModelContext, projectUsage } from "./pi_usage.ts";
import { displayArguments } from "./presentation.ts";

const count = (value: number) => (Number.isFinite(value) && value >= 0 ? value : 0);

function displayContent(content: string | (TextContent | ImageContent)[]) {
  const images = (typeof content === "string" ? [] : content)
    .flatMap((part) => {
      if (part.type !== "image") return [];
      const value = { data: part.data, mimeType: part.mimeType };
      return Value.Check(ChatImageSchema, value) ? [value] : [];
    })
    .slice(0, 3);
  return { text: contentText(content).slice(0, 4_000_000), ...(images.length ? { images } : {}) };
}

/** 从 Pi 原生历史投影界面；聊天历史仍由 SessionManager 保存。 */
export function projectPiHistory(
  entries: SessionEntry[],
  modelContext: ModelContext = () => undefined,
) {
  const messages: MessageInfo[] = [];
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const usage = projectUsage(entries, modelContext);
  let latestResponse: ResponseInfo | null = null;

  for (const entry of entries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      if (
        message.role === "custom" ||
        message.role === "compactionSummary" ||
        message.role === "branchSummary"
      ) {
        if (message.role === "custom" && !message.display) continue;
        messages.push({
          id: entry.id,
          role: "event",
          failed: false,
          timestamp: message.timestamp,
          ...(message.role === "custom"
            ? displayContent(message.content)
            : { text: message.summary.slice(0, 4_000_000) }),
          eventLabel:
            message.role === "custom"
              ? message.customType.slice(0, 200)
              : message.role === "compactionSummary"
                ? "上下文压缩摘要"
                : "分支摘要",
        });
        continue;
      }
      if (message.role === "user") {
        const content = displayContent(message.content);
        messages.push({
          id: entry.id,
          role: "user",
          ...content,
          ...splitStepMessage(content.text),
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

        const model = modelContext(message.provider, message.model);
        const responseUsage = projectUsage([entry], modelContext);

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
  }
  return { messages, usage, latestResponse };
}
