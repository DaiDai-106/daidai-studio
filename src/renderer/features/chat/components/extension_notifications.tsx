import { useEffect, useState } from "react";
import { Icon } from "../../../shared/components/icon.tsx";

type Item = { id: number; message: string; level: string };
export function ExtensionNotifications() {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    let sequence = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const unsubscribe = window.desktop.application.subscribe((event) => {
      if (event.type !== "extension.ui.notification") return;
      const id = ++sequence;
      setItems((current) => [
        ...current.slice(-2),
        { id, message: event.message, level: event.level },
      ]);
      const timer = setTimeout(() => {
        timers.delete(timer);
        setItems((current) => current.filter((item) => item.id !== id));
      }, 8000);
      timers.add(timer);
    });
    return () => {
      unsubscribe();
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);
  return (
    <div className="extension-notifications" aria-live="polite">
      {items.map((item) => (
        <div className={`extension-notification level-${item.level}`} key={item.id}>
          <Icon name="info" size={16} />
          <span className="extension-notification-text">{item.message}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭扩展通知"
            onClick={() => setItems((current) => current.filter((i) => i.id !== item.id))}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
