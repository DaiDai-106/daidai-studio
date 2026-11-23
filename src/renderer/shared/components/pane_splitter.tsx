import type { Dispatch, SetStateAction } from "react";
import { rightPanePercent } from "../logic/pane_size.ts";

// 拖动或使用方向键调整右侧面板宽度，并限制在可用范围内。
export function PaneSplitter({
  className,
  label,
  width,
  min,
  max,
  onWidth,
  unit = "pixels",
}: {
  className?: string;
  label: string;
  width: number;
  min: number;
  max: number;
  onWidth: Dispatch<SetStateAction<number>>;
  unit?: "pixels" | "percent";
}) {
  function resize(clientX: number, element: HTMLElement) {
    if (unit === "percent") {
      const bounds = element.parentElement?.getBoundingClientRect();
      if (bounds) onWidth(rightPanePercent(clientX, bounds, min, max));
      return;
    }
    onWidth(Math.max(min, Math.min(max, window.innerWidth - clientX)));
  }
  return (
    <hr
      className={className ? `splitter ${className}` : "splitter"}
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={unit === "percent" ? `右侧区域 ${Math.round(width)}%` : undefined}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        resize(event.clientX, event.currentTarget);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          resize(event.clientX, event.currentTarget);
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onWidth((current) =>
            Math.max(
              min,
              Math.min(
                max,
                current + (event.key === "ArrowLeft" ? 1 : -1) * (unit === "percent" ? 2 : 20),
              ),
            ),
          );
        }
      }}
    />
  );
}
