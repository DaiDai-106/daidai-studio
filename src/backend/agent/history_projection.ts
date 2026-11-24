import { contentText } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager, SessionStats } from "@earendil-works/pi-coding-agent";
import { splitChatAttachment } from "../../shared/chat_attachment.ts";
import { projectPiHistory } from "./pi_projection.ts";
import { type ModelContext, projectUsage } from "./pi_usage.ts";

const pageSize = 30;

function userText(entry: SessionEntry | undefined) {
  if (entry?.type === "message" && entry.message.role === "user")
    return contentText(entry.message.content ?? []);
}

function indexBranch(branch: SessionEntry[]) {
  const starts: number[] = [];
  const markers = branch.flatMap((entry, index) => {
    const message = userText(entry);
    if (message === undefined) return [];
    const { text, stepAttachment, zipAttachment } = splitChatAttachment(message);
    const label =
      text.slice(0, 240).trim() || (stepAttachment ?? zipAttachment)?.name || "图片消息";
    starts.push(index);
    return [
      {
        id: entry.id,
        label: label.replace(/\s+/g, " ").slice(0, 80),
      },
    ];
  });
  return { branch, starts, markers };
}

function pageEntries(index: ReturnType<typeof indexBranch>, start: number, end: number) {
  // 第一页也保留首条用户消息之前的原生摘要和扩展记录。
  return index.branch.slice(start === 0 ? 0 : index.starts[start], index.starts[end]);
}

export function createHistoryProjection(modelContext: ModelContext = () => undefined) {
  function latest(
    index: ReturnType<typeof indexBranch>,
    manager?: SessionManager,
    statistics?: () => SessionStats,
  ) {
    const { markers, branch } = index;
    const start = Math.max(0, markers.length - pageSize);
    const projected = projectPiHistory(pageEntries(index, start, markers.length), modelContext);
    const previousReply = projected.latestResponse
      ? undefined
      : branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    return {
      messages: projected.messages,
      history: { start, markers },
      latestResponse: previousReply
        ? projectPiHistory([previousReply], modelContext).latestResponse
        : projected.latestResponse,
      branchUsage: start ? projectUsage(branch, modelContext) : projected.usage,
      usage: manager
        ? projectUsage(manager.getEntries(), modelContext, statistics?.())
        : projected.usage,
    };
  }

  const empty = latest(indexBranch([]));
  let cache = new WeakMap<
    SessionManager,
    { key: string; index: ReturnType<typeof indexBranch>; view?: ReturnType<typeof latest> }
  >();

  function indexed(manager: SessionManager) {
    const key = `${manager.getSessionId()}:${manager.getLeafId() ?? "root"}`;
    let entry = cache.get(manager);
    if (entry?.key !== key) {
      entry = { key, index: indexBranch(manager.getBranch()) };
      cache.set(manager, entry);
    }
    return entry;
  }

  return {
    get(manager: SessionManager | undefined, statistics?: () => SessionStats) {
      if (!manager) return { historyKey: "empty", ...empty };
      const entry = indexed(manager);
      entry.view ??= latest(entry.index, manager, statistics);
      return { historyKey: entry.key, ...entry.view };
    },
    read(manager: SessionManager | undefined, turnId: string, before: boolean) {
      const entry = manager && indexed(manager);
      const position = entry?.index.markers.findIndex((marker) => marker.id === turnId) ?? -1;
      if (!entry || position < 0) throw new Error("该轮消息已不在当前分支。");
      const { index, key } = entry;
      const start = before ? Math.max(0, position - pageSize) : position;
      const end = before ? position : Math.min(position + pageSize, index.markers.length);
      return {
        start,
        messages:
          start === end
            ? []
            : projectPiHistory(pageEntries(index, start, end), modelContext).messages,
        nextTurnId: index.markers[end]?.id ?? null,
        historyKey: key,
      };
    },
    firstUserText(manager: SessionManager | undefined) {
      if (!manager) return;
      const { branch, starts } = indexed(manager).index;
      return userText(branch[starts[0] ?? -1])?.slice(0, 4_000_000);
    },
    clear() {
      cache = new WeakMap();
    },
  };
}
