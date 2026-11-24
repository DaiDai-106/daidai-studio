import { useEffect, useMemo, useRef, useState } from "react";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";
import type { PlanningScene } from "../../../../contracts/planning.ts";
import { planningPreviewRobot } from "../../../../shared/scene/planning_preview.ts";
import { RobotViewport } from "../../robot/components/robot_viewport.tsx";
import { createRobotViewport, type ViewportIssue } from "../../robot/logic/robot_viewport.ts";

const unavailable: ViewportIssue = { message: "当前环境无法启动 3D 显示。", blocked: true };

export function PlanningCanvas({
  scene,
  projectId,
  api,
  showCollision,
}: {
  scene: PlanningScene;
  projectId: string;
  api: ApplicationBridge;
  showCollision: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<ReturnType<typeof createRobotViewport>>(null);
  const [issue, setIssue] = useState<ViewportIssue>();
  const { revision, robot } = scene;
  const collisionGeometry = showCollision ? scene.collisionGeometry : undefined;
  const preview = useMemo(
    () => planningPreviewRobot(robot, collisionGeometry),
    [robot, collisionGeometry],
  );

  useEffect(() => {
    if (!host.current) return;
    try {
      viewport.current = createRobotViewport(
        host.current,
        (asset) => api.readPlanningAsset(projectId, revision, asset),
        setIssue,
      );
    } catch {
      setIssue(unavailable);
    }
    return () => {
      viewport.current?.dispose();
      viewport.current = null;
    };
  }, [api, projectId, revision]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 上面的 effect 重建视口后需要同步当前模型。
  useEffect(() => {
    try {
      viewport.current?.update(preview, null);
    } catch {
      setIssue(unavailable);
    }
  }, [api, projectId, revision, preview]);

  return (
    <RobotViewport host={host} viewport={viewport} issue={issue} className="planning-canvas" />
  );
}
