import { useMemo } from "react";
import type { SceneRobot, SceneSelection } from "../../../../contracts/scene.ts";
import { sceneCoordinates } from "../logic/robot_frames.ts";

const format = new Intl.NumberFormat("en", { maximumFractionDigits: 4, useGrouping: false });

function vector(values: readonly number[], scale = 1) {
  return values
    .map((component) => {
      const value = component * scale;
      return Math.abs(value) < 0.00005 ? "0" : format.format(value);
    })
    .join(" / ");
}

export function SceneCoordinates({
  robot,
  selection,
}: {
  robot: SceneRobot;
  selection: SceneSelection;
}) {
  const { entity, id } = selection;
  const coordinates = useMemo(() => sceneCoordinates(robot, entity, id), [robot, entity, id]);
  if (!coordinates) return null;
  return (
    <section className="scene-coordinates" aria-label="坐标变换">
      {(
        [
          ["相对父级", coordinates.local],
          ["世界坐标", coordinates.world],
        ] as const
      ).map(([label, transform]) => (
        <dl key={label} className="scene-transform">
          <dt>{label}</dt>
          <dd>
            <span>XYZ · m</span> <strong>{vector(transform.xyz)}</strong>
          </dd>
          <dd>
            <span>RPY · °</span> <strong>{vector(transform.rpy, 180 / Math.PI)}</strong>
          </dd>
        </dl>
      ))}
    </section>
  );
}
