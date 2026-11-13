import { createContext } from "react";

// 弹窗内容留在原生对话框的顶层；字段通过上下文标记修改。
export const DialogContainerContext = createContext<HTMLElement | undefined>(undefined);
export const DialogChangeContext = createContext<() => void>(() => {});
