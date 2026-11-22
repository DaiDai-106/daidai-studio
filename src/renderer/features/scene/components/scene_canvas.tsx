import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";
import type { SceneJointPreview, SceneRobot } from "../../../../contracts/scene.ts";
import { Icon } from "../../../shared/components/icon.tsx";
import { createSceneViewport, type ViewportIssue } from "../logic/scene_viewport.ts";

export function SceneCanvas({
  projectId,
  api,
  robot,
  selected,
  preview,
  onSelect,
}: {
  projectId: string;
  api: ApplicationBridge;
  robot: SceneRobot;
  selected: string | null;
  preview?: SceneJointPreview | undefined;
  onSelect(id: string): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<ReturnType<typeof createSceneViewport>>(null);
  const [issue, setIssue] = useState<ViewportIssue>();
  const pick = useEffectEvent(onSelect);
  const updateViewport = useEffectEvent(() => viewport.current?.update(robot, selected, preview));
  useEffect(() => {
    if (!host.current) return;
    try {
      viewport.current = createSceneViewport(
        host.current,
        (asset) => api.readSceneAsset(projectId, asset),
        (id) => pick(id),
        setIssue,
      );
      updateViewport();
    } catch {
      setIssue({ message: "当前环境无法启动 3D 显示。仍可在结构树中编辑模型。", blocked: true });
    }
    return () => {
      viewport.current?.dispose();
      viewport.current = null;
    };
  }, [api, projectId]);
  useEffect(() => {
    viewport.current?.update(robot, selected, preview);
  }, [robot, selected, preview]);
  return (
    <div className="scene-view">
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
