import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { DisplayState, ViewportHandle } from "../logic/types.ts";
import { createViewport } from "../logic/viewport.ts";

type Props = DisplayState & {
  ref: Ref<ViewportHandle>;
  onPick?: (id: string | null) => void;
};

export function SceneViewport({
  ref,
  onPick,
  showGrid,
  showAxes,
  model,
  selectedId,
  transparency,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<ReturnType<typeof createViewport> | null>(null);
  const pick = useRef(onPick);
  const [error, setError] = useState("");
  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);
  useImperativeHandle(
    ref,
    () => ({
      fit: () => viewport.current?.fit(),
    }),
    [],
  );
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const lost = (event: Event) => {
      event.preventDefault();
      setError("三维显示连接中断，等待恢复。聊天与场景数据仍保留。");
    };
    const restored = () => {
      setError("");
      viewport.current?.requestRender();
    };
    try {
      viewport.current = createViewport(element, (id) => pick.current?.(id));
    } catch {
      setError("无法启动三维显示，请检查系统图形加速支持。聊天仍可使用。");
      return;
    }
    const canvas = viewport.current.canvas;
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    return () => {
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      viewport.current?.dispose();
      viewport.current = null;
    };
  }, []);
  useEffect(() => {
    viewport.current?.update({
      showGrid,
      showAxes,
      selectedId: selectedId ?? null,
      ...(transparency ? { transparency } : {}),
      ...(model ? { model } : {}),
    });
  }, [showGrid, showAxes, model, selectedId, transparency]);
  return (
    <>
      <div ref={host} className="scene-viewport" />
      {error && (
        <p className="viewport-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
