import { useEffect, useRef, useState } from "react";
import { Icon } from "../../../shared/components/icon.tsx";
import { createSceneViewport, type ViewportIssue } from "../../scene/logic/scene_viewport.ts";
import type { PlanningScene } from "../logic/planning_scene.ts";

export function PlanningCanvas({ scene }: { scene: PlanningScene }) {
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<ReturnType<typeof createSceneViewport>>(null);
  const [issue, setIssue] = useState<ViewportIssue>();

  useEffect(() => {
    if (!host.current) return;
    try {
      const view = createSceneViewport(
        host.current,
        scene.readAsset,
        () => {},
        setIssue,
        "3D 显示暂时中断。",
      );
      viewport.current = view;
      view.update(scene.robot, null);
    } catch {
      setIssue({ message: "当前环境无法启动 3D 显示。", blocked: true });
    }
    return () => {
      viewport.current?.dispose();
      viewport.current = null;
    };
  }, [scene]);

  return (
    <div className="scene-view planning-canvas">
      <div className="scene-canvas" ref={host} />
      {issue && (
        <p className="scene-view-error" role="status">
          {issue.message}
        </p>
      )}
      {!issue?.blocked && (
        <div className="scene-view-actions">
          <button type="button" onClick={() => viewport.current?.fit()}>
            <Icon name="fit" size={14} />
            适应模型
          </button>
          <button type="button" onClick={() => viewport.current?.focusOrigin()}>
            <Icon name="crosshair" size={14} />
            定位原点
          </button>
        </div>
      )}
    </div>
  );
}
