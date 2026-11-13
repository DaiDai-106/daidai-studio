import { parseFileReference } from "../../../../shared/file_references.ts";
import type { Tabs } from "./content_tabs.ts";

export const MAX_SAVED_TABS = 100;

export type WorkspaceState = {
  open: boolean;
  width: number;
  tabs: Tabs;
  navigation: "files" | "changes" | null;
};
const empty = (): WorkspaceState => ({
  open: false,
  width: 50,
  tabs: { items: [], activeId: null },
  navigation: "files",
});

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// 仅保存项目界面状态；网页地址、Cookie 和页面运行状态不落盘。
export function loadCodingWorkspace(projectId: string): WorkspaceState & { error: string } {
  const state = empty();
  if (!projectId) return { ...state, error: "" };
  try {
    const saved = record(JSON.parse(localStorage.getItem(`dai:coding:${projectId}`) ?? "null"));
    if (saved?.version !== 1) return { ...state, error: "" };
    if (typeof saved.open === "boolean") state.open = saved.open;
    if (
      typeof saved.width === "number" &&
      Number.isFinite(saved.width) &&
      saved.width >= 20 &&
      saved.width <= 80
    )
      state.width = saved.width;
    if (saved.navigation === null || saved.navigation === "files" || saved.navigation === "changes")
      state.navigation = saved.navigation;
    const tabs = record(saved.tabs);
    if (Array.isArray(tabs?.items)) {
      const ids = new Set<string>();
      for (const item of tabs.items.slice(0, MAX_SAVED_TABS)) {
        const tab = record(item);
        const content = record(tab?.content);
        if (
          typeof tab?.id !== "string" ||
          !/^[a-f\d-]{36}$/iu.test(tab.id) ||
          ids.has(tab.id) ||
          typeof content?.path !== "string" ||
          !parseFileReference(JSON.stringify(content.path))
        )
          continue;
        ids.add(tab.id);
        if (content.type === "file")
          state.tabs.items.push({ id: tab.id, content: { type: "file", path: content.path } });
        else if (
          content.type === "diff" &&
          (content.kind === "staged" || content.kind === "unstaged" || content.kind === "untracked")
        )
          state.tabs.items.push({
            id: tab.id,
            content: { type: "diff", path: content.path, kind: content.kind },
          });
      }
      state.tabs.activeId =
        state.tabs.items.find((tab) => tab.id === tabs.activeId)?.id ??
        state.tabs.items.at(-1)?.id ??
        null;
    }
    return { ...state, error: "" };
  } catch {
    return { ...state, error: "工作区状态无法恢复，本次使用默认布局。" };
  }
}

export function saveCodingWorkspace(projectId: string, state: WorkspaceState) {
  if (!projectId) return "";
  try {
    const candidates = state.tabs.items.filter((tab) => tab.content.type !== "preview");
    const items = candidates.slice(-MAX_SAVED_TABS);
    const active = candidates.find((tab) => tab.id === state.tabs.activeId);
    // 标签顺序即打开顺序；超限时保留最近打开的标签，并优先保留当前活动项。
    if (active && !items.includes(active)) {
      items.shift();
      items.unshift(active);
    }
    const activeId =
      items.find((tab) => tab.id === state.tabs.activeId)?.id ?? items.at(-1)?.id ?? null;
    localStorage.setItem(
      `dai:coding:${projectId}`,
      JSON.stringify({ ...state, version: 1, tabs: { items, activeId } }),
    );
    return "";
  } catch {
    return "无法保存工作区状态，关闭应用后可能无法恢复布局。";
  }
}
