import type {
  ConversationView,
  MessageBlock,
  MessageInfo,
  ToolProgressInfo,
} from "../../../../contracts/application.ts";

export interface ConversationTurn {
  id: string;
  user?: MessageInfo;
  messages: MessageInfo[];
}

// 按轮次组织已有消息，仅用于显示，不另存一份历史。
export function conversationTurns(messages: readonly MessageInfo[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") turns.push({ id: message.id, user: message, messages: [] });
    else if (message.role === "event") turns.push({ id: message.id, messages: [] });
    else {
      if (!turns.length) turns.push({ id: message.id, messages: [] });
      turns.at(-1)?.messages.push(message);
    }
  }
  return turns;
}

export function finalReply(turn: ConversationTurn) {
  const last = turn.messages.at(-1);
  return last?.role === "assistant" && !last.hasToolCalls ? last : undefined;
}

export function toolSummary(name: string, args?: Record<string, unknown>) {
  if (!args) return "";
  if (name === "read" && typeof args.path === "string") {
    const filename = args.path.split(/[\\/]/).at(-1) ?? args.path;
    const offset = typeof args.offset === "number" ? args.offset : 1;
    return `${filename} · 从第 ${offset} 行起${typeof args.limit === "number" ? `，最多 ${args.limit} 行` : ""}`;
  }
  if (typeof args.path === "string") return args.path.split(/[\\/]/).at(-1) ?? args.path;
  const fields = Object.entries(args)
    .filter(([, value]) => value !== undefined)
    .slice(0, 3);
  return fields
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
    )
    .join(" · ")
    .slice(0, 180);
}

export function durationLabel(milliseconds: number | null | undefined) {
  if (milliseconds === undefined || milliseconds === null || !Number.isFinite(milliseconds))
    return "";
  return milliseconds < 1000
    ? `${Math.round(milliseconds)} ms`
    : `${(milliseconds / 1000).toFixed(1)} s`;
}

export type ToolRowData = {
  key: string;
  name: string;
  serverName?: string;
  displayName?: string;
  args?: Record<string, unknown>;
  argsTruncated?: boolean;
  output?: string;
  outputTruncated?: boolean;
  images?: MessageInfo["images"];
  durationMs?: number | null;
  status: "pending" | "running" | "completed" | "failed" | "stopped";
  phase?: string;
};

export function completedTool(message: MessageInfo): ToolRowData {
  const tool = message.tool;
  return {
    ...tool,
    key: tool?.callKey ?? tool?.callId ?? message.id,
    name: tool?.name ?? "tool",
    output: message.text,
    ...(message.images?.length ? { images: message.images } : {}),
    status: message.outcome === "stopped" ? "stopped" : message.failed ? "failed" : "completed",
  };
}

export function runningTool(tool: ToolProgressInfo): ToolRowData {
  return { ...tool, key: tool.callKey ?? tool.id };
}

export type ProcessItem =
  | { key: string; kind: "tool"; tool: ToolRowData }
  | { key: string; kind: "thinking"; block: MessageBlock }
  | { key: string; kind: "note"; text: string };

// 实时调用转为历史记录时沿用键值，保持已展开的工具行。
export function processItems(
  turn: ConversationTurn,
  stream: ConversationView | null,
): ProcessItem[] {
  const items: ProcessItem[] = [];
  const final = finalReply(turn);
  let assistantIndex = 0;

  function blocks(values: MessageBlock[], index: number, includeText: boolean) {
    values.forEach((block, blockIndex) => {
      const key = `assistant:${index}:${blockIndex}`;
      if (block.kind === "thinking" && block.text) items.push({ key, kind: "thinking", block });
      else if (includeText && block.text) items.push({ key, kind: "note", text: block.text });
    });
  }

  for (const message of turn.messages) {
    if (message.role === "tool") {
      const tool = completedTool(message);
      items.push({ key: `tool:${tool.key}`, kind: "tool", tool });
    } else if (message.role === "assistant") {
      blocks(
        message.blocks ?? [{ kind: "text", text: message.text }],
        assistantIndex++,
        message !== final,
      );
    }
  }

  blocks(stream?.partialBlocks ?? [], assistantIndex, !!stream?.partialHasToolCalls);
  const finished = new Set(items.filter((item) => item.kind === "tool").map((item) => item.key));
  for (const pending of stream?.activeTools ?? []) {
    const tool = runningTool(pending);
    if (!finished.has(`tool:${tool.key}`))
      items.push({ key: `tool:${tool.key}`, kind: "tool", tool });
  }
  return items;
}
