import type { ProjectInfo } from "../../../../contracts/application.ts";
import { Icon, type IconName } from "../../../shared/components/icon.tsx";
import "../styles/project_mode_icon.css";

const icons = { coding: "code", scene: "box" } satisfies Record<ProjectInfo["mode"], IconName>;

export function ProjectModeIcon({
  mode,
  size = 16,
  className = "",
}: {
  mode: ProjectInfo["mode"];
  size?: number;
  className?: string;
}) {
  return (
    <span className={`project-mode-icon ${className}`} data-mode={mode}>
      <Icon name={icons[mode]} size={size} />
    </span>
  );
}
