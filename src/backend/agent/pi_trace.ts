import {
  contentText,
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { TraceDetail, TraceRecord } from "../../contracts/application.ts";
import { displayArguments } from "./presentation.ts";

function messageAt(entry: SessionEntry) {
  // 压缩检查点自带 system 快照；列表显示一次压缩事件，详情仍由 SDK 重放检查点。
  const messages = sessionEntryToContextMessages(entry);
  return entry.type === "message" ? entry.message : messages.find((m) => m.role !== "system");
}

function messageText(message: NonNullable<ReturnType<typeof messageAt>>) {
  return "summary" in message
    ? message.summary
    : "content" in message
      ? contentText(message.content)
      : `${message.command}\n${message.output}`;
}

/** 摘要不携带整套提示词或 schema，避免每次流式更新重复传输大型上下文。 */
export function projectTrace(entries: SessionEntry[]): TraceRecord[] {
  let turn = 0;
  return entries.flatMap((entry) => {
    const message = messageAt(entry);
    if (!message) return [];
    if (message.role === "user") turn++;
    const role: TraceRecord["role"] =
      message.role === "toolResult"
        ? "tool"
        : ["system", "user", "assistant"].includes(message.role)
          ? (message.role as "system" | "user" | "assistant")
          : "event";
    let label = "会话事件";
    if (message.role === "system") label = "系统提示与工具更新";
    else if (message.role === "user") label = "用户输入";
    else if (message.role === "assistant") label = message.model;
    else if (message.role === "toolResult") label = message.toolName;
    else if (message.role === "custom")
      label = message.display ? message.customType : `插件注入 · ${message.customType}`;
    else if (message.role === "compactionSummary") label = "上下文压缩摘要";
    else if (message.role === "branchSummary") label = "分支摘要";
    const text = messageText(message);
    const preview =
      message.role === "system"
        ? [
            text,
            ...Object.entries(message.sections ?? {}).map(([name, value]) =>
              value === null ? `移除 ${name}` : name,
            ),
            ...(message.toolsAdded ?? []).map((tool) => `+ ${tool.name}`),
            ...(message.toolsRemoved ?? []).map((tool) => `− ${tool.name}`),
          ].join(" · ")
        : text ||
          (message.role === "assistant"
            ? message.content
                .filter((part) => part.type === "toolCall")
                .map((part) => part.name)
                .join("、")
            : "");
    return [
      {
        id: entry.id,
        role,
        turn,
        label: label.slice(0, 200),
        preview: preview.replace(/\s+/g, " ").slice(0, 500),
        timestamp: Number.isFinite(message.timestamp)
          ? message.timestamp
          : Date.parse(entry.timestamp),
        failed:
          message.role === "toolResult"
            ? message.isError
            : message.role === "assistant" && ["error", "aborted"].includes(message.stopReason),
      },
    ];
  });
}

/** 按选中记录的位置重放，历史上下文不会混入现在的插件、工具或其他分支。 */
export function traceDetail(entries: SessionEntry[], entryId: string): TraceDetail {
  const index = entries.findIndex((entry) => entry.id === entryId);
  const entry = entries[index];
  if (!entry) throw new Error("轨迹记录不存在或已不在当前分支。");
  const message = messageAt(entry);
  if (!message) throw new Error("该历史记录没有可展示的轨迹内容。");
  let truncated = false;
  let remaining = 4_000_000;
  const text = (value: string) => {
    const result = value.slice(0, remaining);
    if (result.length < value.length) truncated = true;
    remaining -= result.length;
    return result;
  };
  const detail: TraceDetail = { text: text(messageText(message)), calls: [], truncated: false };
  if (message.role === "assistant") {
    detail.calls = message.content.flatMap((part) =>
      part.type === "toolCall"
        ? [
            {
              callId: part.id.slice(0, 1000),
              name: part.name.slice(0, 200),
              ...displayArguments(part.arguments),
            },
          ]
        : [],
    );
  }
  if (message.role === "toolResult") {
    // 参数来自原始调用，沿用聊天卡片的脱敏规则，不修改真正执行过的历史。
    const call = entries
      .slice(0, index)
      .flatMap((item) =>
        item.type === "message" && item.message.role === "assistant" ? item.message.content : [],
      )
      .findLast((part) => part.type === "toolCall" && part.id === message.toolCallId);
    if (message.details !== undefined) {
      const result = displayArguments({ result: message.details });
      detail.text += text(`\n\n结构化结果\n${JSON.stringify(result.args?.result, null, 2)}`);
      if (result.argsTruncated) truncated = true;
    }
    detail.tool = {
      name: message.toolName.slice(0, 200),
      callId: message.toolCallId.slice(0, 1000),
      ...(call?.type === "toolCall" ? displayArguments(call.arguments) : {}),
      durationMs: message.durationMs === undefined ? null : Math.max(0, message.durationMs),
    };
  }
  if (["system", "user", "assistant"].includes(message.role) || entry.type === "compaction") {
    let end = message.role === "assistant" ? index : index + 1;
    // 用户行查看本轮首次请求；系统分段可能在用户输入之后、模型响应之前更新。
    if (message.role === "user") {
      while (end < entries.length) {
        const next = entries[end];
        const role = next ? messageAt(next)?.role : undefined;
        if (role === "assistant" || role === "user") break;
        end++;
      }
    }
    const prefix = entries.slice(0, end);
    const projection = buildSessionProjection(prefix);
    const context = projection.messages;
    const system = getCurrentSystemMessage(context);
    detail.context = {
      recorded: !!system,
      content: text(getCurrentSystemPrompt(system ? [system] : [])),
      sections: Object.entries(system?.sections ?? {}).flatMap(([name, value]) =>
        value === null ? [] : [{ name: name.slice(0, 1000), text: text(value) }],
      ),
      // display 只控制聊天是否展示；上下文检查保留 SDK 实际传给模型的扩展消息。
      injections: projection.entries.flatMap(({ sourceEntry, messages }) =>
        messages.flatMap((item) =>
          item.role === "custom"
            ? [
                {
                  id: sourceEntry.id,
                  name: item.customType.slice(0, 1000),
                  text: text(contentText(item.content)),
                },
              ]
            : [],
        ),
      ),
      tools: (system?.toolsAdded ?? []).map((tool) => {
        // schema 是工具声明，不把名为 token/password 的参数定义误当成凭据值。
        const parameters = JSON.stringify(tool.parameters, null, 2);
        return {
          name: tool.name.slice(0, 500),
          description: text(tool.description),
          parameters: text(parameters.slice(0, 100_000)),
          truncated: parameters.length > 100_000,
        };
      }),
    };
  }
  detail.truncated = truncated;
  return detail;
}
