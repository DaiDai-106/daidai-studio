import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

const OverlayContext = createContext<{
  blocked: boolean;
  setOpen: (id: symbol, open: boolean) => void;
} | null>(null);

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [openOverlays, setOpenOverlays] = useState<Set<symbol>>(() => new Set());
  const [setOpen] = useState(() => (id: symbol, open: boolean) => {
    setOpenOverlays((previous) => {
      if (previous.has(id) === open) return previous;
      const next = new Set(previous);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  });
  return (
    <OverlayContext value={{ blocked: openOverlays.size > 0, setOpen }}>{children}</OverlayContext>
  );
}

export function useOverlayBlocked() {
  return useContext(OverlayContext)?.blocked ?? false;
}

// 每个菜单或弹窗独立登记，卸载时也解除遮挡。
export function useOverlay(open: boolean) {
  const setOpen = useContext(OverlayContext)?.setOpen;
  const [id] = useState(() => Symbol());
  useEffect(() => {
    if (!setOpen || !open) return;
    setOpen(id, true);
    return () => setOpen(id, false);
  }, [id, open, setOpen]);
}
