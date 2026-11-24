import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";
import type {
  SceneJointPreview,
  SceneRobot,
  SceneVisualOpacities,
} from "../../../../contracts/scene.ts";
import { RobotViewport } from "../../robot/components/robot_viewport.tsx";
import { createRobotViewport, type ViewportIssue } from "../../robot/logic/robot_viewport.ts";

export function SceneCanvas({
  projectId,
  api,
  robot,
  transparency,
  opacities,
  transparencyMixed,
  transparencyDisabled,
  onTransparencyChange,
  onTransparencyCommit,
  onTransparencyCancel,
  selected,
  preview,
  onSelect,
}: {
  projectId: string;
  api: ApplicationBridge;
  robot: SceneRobot;
  transparency: number;
  opacities: SceneVisualOpacities;
  transparencyMixed: boolean;
  transparencyDisabled: boolean;
  onTransparencyChange(value: number): void;
  onTransparencyCommit(): void;
  onTransparencyCancel(): void;
  selected: string | null;
  preview?: SceneJointPreview | undefined;
  onSelect(id: string): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<ReturnType<typeof createRobotViewport>>(null);
  const [issue, setIssue] = useState<ViewportIssue>();
  const opacityPointer = useRef<number | undefined>(undefined);
  const opacityCancelled = useRef(false);

  function cancelOpacity() {
    opacityCancelled.current = true;
    opacityPointer.current = undefined;
    onTransparencyCancel();
  }

  function commitOpacity() {
    opacityPointer.current = undefined;
    if (!opacityCancelled.current) onTransparencyCommit();
  }
  const pick = useEffectEvent(onSelect);
  useEffect(() => {
    if (!host.current) return;
    try {
      viewport.current = createRobotViewport(
        host.current,
        (asset) => api.readSceneAsset(projectId, asset),
        setIssue,
        { onSelect: (id) => pick(id), blockedMessage: "3D 显示暂时中断。仍可在结构树中编辑模型。" },
      );
    } catch {
      setIssue({ message: "当前环境无法启动 3D 显示。仍可在结构树中编辑模型。", blocked: true });
    }
    return () => {
      viewport.current?.dispose();
      viewport.current = null;
    };
  }, [api, projectId]);
  useEffect(() => {
    try {
      viewport.current?.update(robot, selected, preview, opacities);
    } catch {
      setIssue({ message: "当前环境无法启动 3D 显示。仍可在结构树中编辑模型。", blocked: true });
    }
  }, [robot, selected, preview, opacities]);
  return (
    <RobotViewport host={host} viewport={viewport} issue={issue}>
      <label className="scene-reference-opacity">
        所选透明度 {transparencyMixed ? "混合" : `${transparency}%`}
        <input
          type="range"
          aria-label="所选对象透明度"
          title={
            transparencyDisabled
              ? "请先选择有几何的零件、装配或连杆"
              : "仅调整所选对象及其子级；0% 完全不透明"
          }
          disabled={transparencyDisabled}
          min="0"
          max="100"
          step="1"
          value={transparency}
          onChange={(event) => {
            if (!opacityCancelled.current) onTransparencyChange(event.currentTarget.valueAsNumber);
          }}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) {
              event.preventDefault();
              return;
            }
            opacityPointer.current = event.pointerId;
            opacityCancelled.current = false;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={commitOpacity}
          onPointerCancel={cancelOpacity}
          onLostPointerCapture={(event) => {
            if (opacityPointer.current === event.pointerId) cancelOpacity();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") cancelOpacity();
            else opacityCancelled.current = false;
          }}
          onKeyUp={commitOpacity}
          onBlur={() => {
            if (opacityPointer.current !== undefined) cancelOpacity();
            else commitOpacity();
          }}
        />
      </label>
    </RobotViewport>
  );
}
