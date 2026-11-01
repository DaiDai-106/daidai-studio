import { useEffect } from "react";

const isMac = navigator.platform.startsWith("Mac");
export const shortcuts = [
  { id: "newChat", label: "新建对话", code: "KeyN", key: "N" },
  { id: "openProject", label: "新建项目", code: "KeyO", key: "O" },
  { id: "settings", label: "打开设置", code: "Comma", key: "," },
  { id: "toggleSidebar", label: "显示 / 隐藏项目栏", code: "KeyB", key: "B" },
  { id: "focusChat", label: "聚焦聊天输入框", code: "KeyL", key: "L" },
  { id: "shortcuts", label: "查看快捷键", code: "Slash", key: "/" },
] as const;
type ShortcutId = (typeof shortcuts)[number]["id"];
export const zoomShortcuts = [
  { id: "zoomIn", label: "放大界面字体", key: "+ / =" },
  { id: "zoomOut", label: "缩小界面字体", key: "−" },
  { id: "resetZoom", label: "恢复默认大小", key: "0" },
] as const;

export function shortcutLabel(id: ShortcutId | (typeof zoomShortcuts)[number]["id"]) {
  const shortcut = [...shortcuts, ...zoomShortcuts].find((item) => item.id === id);
  return `${isMac ? "⌘" : "Ctrl"} ${shortcut?.key ?? ""}`;
}

export function useShortcuts(actions: Record<ShortcutId, () => void>, enabled: boolean) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        !enabled ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        !(isMac ? event.metaKey : event.ctrlKey) ||
        document.querySelector('dialog[open], [role="menu"], [role="listbox"]')
      )
        return;
      const shortcut = shortcuts.find((item) => item.code === event.code);
      if (!shortcut) return;
      event.preventDefault();
      actions[shortcut.id]();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions, enabled]);
}
