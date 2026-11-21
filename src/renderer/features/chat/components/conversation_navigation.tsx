import { type RefObject, useEffect, useRef, useState } from "react";
import type { ConversationView } from "../../../../contracts/application.ts";

export type ConversationScrollPin = { top: number; turnId?: string };

export function ConversationNavigation({
  markers,
  messages,
  scrollArea,
  scrollPin,
  visible,
  onJump,
}: {
  markers: ConversationView["history"]["markers"];
  messages: ConversationView["messages"];
  scrollArea: RefObject<HTMLDivElement | null>;
  scrollPin: RefObject<ConversationScrollPin | null>;
  visible: boolean;
  onJump(id: string): boolean;
}) {
  const [activeId, setActiveId] = useState<string>();
  const rail = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!visible || markers.length < 2 || !messages.length) return;
    const area = scrollArea.current;
    if (!area) return;
    const column = area.querySelector(".message-column");
    if (!column) return;

    const turns = Array.from(
      column.querySelectorAll<HTMLElement>("[data-user-turn]"),
      (element) => ({
        id: element.dataset.turnId,
        element,
      }),
    );
    const ids = new Set(turns.map(({ id }) => id));
    let frame = 0;
    const sync = () => {
      const selected = scrollPin.current;
      if (
        selected?.turnId &&
        ids.has(selected.turnId) &&
        Math.abs(area.scrollTop - selected.top) < 2
      ) {
        setActiveId(selected.turnId);
        return;
      }
      if (area.scrollHeight - area.clientHeight - area.scrollTop < 2) {
        setActiveId(turns.at(-1)?.id);
        return;
      }
      const readingLine = area.getBoundingClientRect().top + Math.min(100, area.clientHeight / 4);
      // 轮次按文档顺序排列，滚动时只测量命中点附近的元素。
      let first = 0;
      let last = turns.length;
      while (first < last) {
        const middle = Math.floor((first + last) / 2);
        if ((turns[middle]?.element.getBoundingClientRect().top ?? Infinity) <= readingLine)
          first = middle + 1;
        else last = middle;
      }
      setActiveId(turns[Math.max(0, first - 1)]?.id);
    };
    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    }
    area.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(area);
    observer.observe(column);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      area.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [markers, messages, scrollArea, scrollPin, visible]);

  useEffect(() => {
    if (!visible || !activeId) return;
    const list = rail.current;
    const button = list?.querySelector('[aria-current="location"]');
    if (!list || !button) return;
    const { top, bottom } = button.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    if (top < bounds.top) list.scrollTop += top - bounds.top;
    if (bottom > bounds.bottom) list.scrollTop += bottom - bounds.bottom;
  }, [activeId, visible]);

  if (!visible || markers.length < 2) return null;
  return (
    <nav ref={rail} className="conversation-navigation" aria-label="跳转到用户消息">
      {markers.map(({ id, label }, index) => (
        <button
          key={id}
          type="button"
          aria-label={`跳转到第 ${index + 1} 条消息：${label}`}
          aria-current={id === activeId ? "location" : undefined}
          title={`${index + 1} · ${label}`}
          onClick={() => {
            if (onJump(id)) setActiveId(id);
          }}
        />
      ))}
    </nav>
  );
}
