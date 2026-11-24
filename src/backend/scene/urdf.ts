import type { SceneJoint, SceneOrigin, SceneRobot, SceneVisual } from "../../contracts/scene.ts";
import { maxUrdfBytes } from "../../contracts/scene.ts";
import { importNotesPrefix } from "../../shared/scene/urdf.ts";

export { parseUrdf } from "../../shared/scene/urdf.ts";

const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeXml = (value: string) =>
  value.replace(/[&<>"]/g, (character) => escapes[character] ?? character);
const originXml = ({ xyz, rpy }: SceneOrigin) =>
  `<origin xyz="${xyz.join(" ")}" rpy="${rpy.join(" ")}"/>`;

function geometryXml(shape: SceneVisual["geometry"]) {
  switch (shape.type) {
    case "box":
      return `<box size="${shape.size.join(" ")}"/>`;
    case "sphere":
      return `<sphere radius="${shape.radius}"/>`;
    case "cylinder":
      return `<cylinder radius="${shape.radius}" length="${shape.length}"/>`;
    case "mesh":
      return `<mesh filename="meshes/${shape.asset}" scale="${shape.scale.join(" ")}"/>`;
  }
}

function limitXml({ lower, upper, effort, velocity }: NonNullable<SceneJoint["limit"]>) {
  const bounds =
    lower !== undefined && upper !== undefined ? ` lower="${lower}" upper="${upper}"` : "";
  return `    <limit${bounds} effort="${effort}" velocity="${velocity}"/>`;
}

export function writeUrdf(robot: SceneRobot, warnings: readonly string[] = []) {
  const names = new Map(robot.links.map((link) => [link.id, escapeXml(link.name)]));
  const links = robot.links.map((link, i) =>
    [
      `  <link name="${escapeXml(link.name)}">`,
      ...link.visuals.flatMap((visual, j) => [
        "    <visual>",
        `      ${originXml(visual.origin)}`,
        `      <geometry>${geometryXml(visual.geometry)}</geometry>`,
        ...(visual.color
          ? [
              `      <material name="material_${i}_${j}"><color rgba="${visual.color.join(" ")}"/></material>`,
            ]
          : []),
        "    </visual>",
      ]),
      "  </link>",
    ].join("\n"),
  );
  const joints = robot.joints.map((joint) =>
    [
      `  <joint name="${escapeXml(joint.name)}" type="${joint.type}">`,
      `    <parent link="${names.get(joint.parentId)}"/>`,
      `    <child link="${names.get(joint.childId)}"/>`,
      `    ${originXml(joint.origin)}`,
      ...(joint.type === "fixed" ? [] : [`    <axis xyz="${joint.axis.join(" ")}"/>`]),
      ...(joint.limit ? [limitXml(joint.limit)] : []),
      "  </joint>",
    ].join("\n"),
  );
  const source = [
    '<?xml version="1.0"?>',
    `<robot name="${escapeXml(robot.name)}">`,
    ...(warnings.length
      ? [
          `  <!-- ${importNotesPrefix}${JSON.stringify(warnings)
            .replaceAll("--", "-\\u002d")
            .replace(
              /[<\ufffe\uffff]/gu,
              (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
            )} -->`,
        ]
      : []),
    ...links,
    ...joints,
    "</robot>",
    "",
  ].join("\n");
  if (Buffer.byteLength(source) > maxUrdfBytes) throw new Error("导出的 URDF 超过 1 MiB。");
  return source;
}
