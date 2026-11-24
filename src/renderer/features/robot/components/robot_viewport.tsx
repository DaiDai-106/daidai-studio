import type { ReactNode, RefObject } from "react";
import { Icon } from "../../../shared/components/icon.tsx";
import type { createRobotViewport, ViewportIssue } from "../logic/robot_viewport.ts";

export function RobotViewport({
  host,
  viewport,
  issue,
  className,
  children,
}: {
  host: RefObject<HTMLDivElement | null>;
  viewport: RefObject<ReturnType<typeof createRobotViewport> | null>;
  issue: ViewportIssue | undefined;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={className ? `scene-view ${className}` : "scene-view"}>
      <div className="scene-canvas" ref={host} />
      {issue && (
        <p className="scene-view-error" role="status">
          {issue.message}
        </p>
      )}
      {!issue?.blocked && (
        <div className="scene-view-actions">
          {children}
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
