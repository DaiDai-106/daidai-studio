import { createContext } from "react";

// Portals stay inside a native dialog's top layer; custom fields also mark edits.
export const DialogContainerContext = createContext<HTMLElement | undefined>(undefined);
export const DialogChangeContext = createContext<() => void>(() => {});
