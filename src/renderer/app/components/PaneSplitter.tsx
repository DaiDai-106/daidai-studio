import type { Dispatch, SetStateAction } from "react";

// 拖动或使用方向键调整右侧面板宽度，并限制在可用范围内。
export function PaneSplitter({
  className,
  label,
  width,
  min,
  max,
  onWidth,
}: {
  className?: string;
  label: string;
  width: number;
  min: number;
  max: number;
  onWidth: Dispatch<SetStateAction<number>>;
}) {
  function resize(clientX: number) {
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
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        resize(event.clientX);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX);
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onWidth((current) =>
            Math.max(min, Math.min(max, current + (event.key === "ArrowLeft" ? 20 : -20))),
          );
        }
      }}
    />
  );
}
