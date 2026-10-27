import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  type ComparisonIdentity,
  canComparePlacement,
  labelPlacementComparison,
  type PlacementComparison,
} from "./placementComparison.ts";
import type { DisplayState, ViewportHandle } from "./types.ts";
import { createViewport } from "./viewport.ts";

type Props = DisplayState & {
  ref: Ref<ViewportHandle>;
  onPick?: (id: string | null) => void;
  importId?: string | undefined;
  sceneReady?: boolean;
  comparisonEnabled?: boolean;
  onComparison?: (value: PlacementComparison | null) => void;
};

export function SceneViewport({
  ref,
  onPick,
  showGrid,
  showAxes,
  model,
  selectedId,
  transparency,
  placement,
  importId,
  sceneReady = false,
  comparisonEnabled = false,
  onComparison,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<ReturnType<typeof createViewport> | null>(null);
  const pick = useRef(onPick);
  const comparison = useRef(onComparison);
  const previous = useRef<ComparisonIdentity | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);
  useEffect(() => {
    comparison.current = onComparison;
  }, [onComparison]);
  useImperativeHandle(
    ref,
    () => ({
      fit: () => viewport.current?.fit(),
      setView: (view) => viewport.current?.setView(view),
      capture: (view) => viewport.current?.capture(view) ?? null,
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
    const engine = viewport.current;
    if (!engine) {
      previous.current = null;
      return;
    }
    const next = {
      showGrid,
      showAxes,
      selectedId: selectedId ?? null,
      placement: placement ?? null,
      ...(transparency ? { transparency } : {}),
      ...(model ? { model } : {}),
    };
    const identity =
      sceneReady && importId && model
        ? { importId, revision: placement?.revision ?? 0, model }
        : null;
    const prior = previous.current;
    if (identity && prior && canComparePlacement(prior, identity, comparisonEnabled)) {
      const images = engine.updateWithComparison(next);
      comparison.current?.(images ? labelPlacementComparison(prior, identity, images) : null);
    } else engine.update(next);
    previous.current = identity;
  }, [
    showGrid,
    showAxes,
    model,
    selectedId,
    transparency,
    placement,
    importId,
    sceneReady,
    comparisonEnabled,
  ]);
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
