import { useMemo } from "react";
import type { SceneRobot, SceneSelection } from "../../../../contracts/scene.ts";
import { sceneCoordinates } from "../../../../shared/scene/frames.ts";

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
  readOnly = false,
}: {
  robot: SceneRobot;
  selection: SceneSelection;
  readOnly?: boolean;
}) {
  const { entity, id } = selection;
  const coordinates = useMemo(() => sceneCoordinates(robot, entity, id), [robot, entity, id]);
  if (!coordinates) return null;
  const joint = robot.joints.find((item) =>
    entity === "link" ? item.childId === id : item.id === id,
  );
  const parent = robot.links.find((link) => link.id === joint?.parentId);
  const parentName = parent
    ? `${parent.name}${readOnly && parent.id === robot.rootLinkId ? "（原始模型虚拟根）" : ""}`
    : "无（根节点，以世界坐标为基准）";
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
          {label === "相对父级" && (
            <dd>
              <span>父级连杆</span> <strong>{parentName}</strong>
            </dd>
          )}
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
