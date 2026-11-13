import type { ApplicationBridge } from "../../../../contracts/bridge.ts";
import type { FileReference } from "../../../../shared/file_references.ts";

export type DiffKind = Parameters<ApplicationBridge["readCodingDiff"]>[2];
export type TextContent =
  | ({ type: "file" } & FileReference)
  | { type: "diff"; path: string; kind: DiffKind };
export type Content = TextContent | { type: "preview"; url: string; file?: string };
type Tab = { id: string; content: Content };
export type Tabs = { items: Tab[]; activeId: string | null };
export type TabsAction =
  | { type: "open"; tab: Tab }
  | { type: "select"; id: string }
  | { type: "close"; id: string };

function sameResource(first: Content, second: Content) {
  if (first.type === "file" && second.type === "file") return first.path === second.path;
  return (
    first.type === "diff" &&
    second.type === "diff" &&
    first.path === second.path &&
    first.kind === second.kind
  );
}

// 文件与各基准的差异复用标签；网页保留独立实例，标签属于项目。
export function tabsReducer(state: Tabs, action: TabsAction): Tabs {
  if (action.type === "select") return { ...state, activeId: action.id };
  if (action.type === "open") {
    const existing = state.items.find(
      (item) => item.id === action.tab.id || sameResource(item.content, action.tab.content),
    );
    return existing
      ? {
          ...state,
          items: state.items.map((item) =>
            item.id === existing.id ? { ...item, content: action.tab.content } : item,
          ),
          activeId: existing.id,
        }
      : { items: [...state.items, action.tab], activeId: action.tab.id };
  }
  const index = state.items.findIndex((item) => item.id === action.id);
  if (index < 0) return state;
  const items = state.items.filter((item) => item.id !== action.id);
  const activeId =
    state.activeId === action.id
      ? (items[Math.min(index, items.length - 1)]?.id ?? null)
      : state.activeId;
  return { items, activeId };
}
