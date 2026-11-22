import { DOMParser, type Element, Node } from "@xmldom/xmldom";
import { Value } from "typebox/value";
import type { SceneJoint, SceneOrigin, SceneRobot, SceneVisual } from "../../contracts/scene.ts";
import { maxSceneWarnings, maxUrdfBytes, SceneWarningsSchema } from "../../contracts/scene.ts";
import { zeroOrigin } from "./document.ts";

const children = (node: Element, tag: string) =>
  Array.from(node.children).filter((child) => child.tagName === tag);
const importNotesPrefix = "Dai Studio import notes: ";
const child = (node: Element, tag: string) => {
  const matches = children(node, tag);
  if (matches.length > 1) throw new Error(`URDF 元素重复：${tag}。`);
  return matches[0];
};

function attribute(node: Element | undefined, name: string) {
  const value = node?.getAttribute(name);
  if (!value?.trim()) throw new Error(`URDF 缺少 ${name}。`);
  return value;
}

function number(value: string) {
  value = value.trim();
  const parsed = Number(value);
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(parsed))
    throw new Error("URDF 数值无效。");
  return parsed;
}

function vector(value: string, size: 3): SceneOrigin["xyz"];
function vector(value: string, size: 4): NonNullable<SceneVisual["color"]>;
function vector(value: string, size: 3 | 4) {
  const items = value.trim().split(/\s+/).map(number);
  if (items.length !== size) throw new Error(`URDF 向量应包含 ${size} 个数字。`);
  return items;
}

function origin(node: Element): SceneOrigin {
  const element = child(node, "origin");
  if (element?.hasAttribute("quat_xyzw")) throw new Error("此版本的 URDF 不支持四元数 origin。");
  const result = zeroOrigin();
  const xyz = element?.getAttribute("xyz");
  const rpy = element?.getAttribute("rpy");
  if (xyz != null) result.xyz = vector(xyz, 3);
  if (rpy != null) result.rpy = vector(rpy, 3);
  return result;
}

function geometry(node: Element | undefined): SceneVisual["geometry"] {
  if (node?.children.length !== 1) throw new Error("每个 visual 需要一种几何体。");
  const shape = node.children[0];
  switch (shape?.tagName) {
    case "box":
      return { type: "box", size: vector(attribute(shape, "size"), 3) };
    case "sphere":
      return { type: "sphere", radius: number(attribute(shape, "radius")) };
    case "cylinder":
      return {
        type: "cylinder",
        radius: number(attribute(shape, "radius")),
        length: number(attribute(shape, "length")),
      };
    case "mesh":
      return {
        type: "mesh",
        asset: attribute(shape, "filename"),
        scale: vector(shape.getAttribute("scale") ?? "1 1 1", 3),
      };
    default:
      throw new Error("仅支持 box、sphere、cylinder 和 STL mesh。");
  }
}

function parseXml(source: string) {
  if (Buffer.byteLength(source) > maxUrdfBytes) throw new Error("URDF 文件超过 1 MiB。");
  if (/<!DOCTYPE\s/.test(source)) throw new Error("URDF 不支持文档类型声明。");
  const document = new DOMParser({
    onError: (_level, message) => {
      throw new Error(message.slice(0, 500));
    },
  }).parseFromString(source, "application/xml");
  const root = document.documentElement;
  if (root?.tagName !== "robot") throw new Error("URDF 根元素必须为 robot。");
  let size = 0;
  function inspect(node: Element, depth: number) {
    if (depth >= 32 || ++size > 100_000) throw new Error("URDF 结构超出大小限制。");
    if (node.namespaceURI) throw new Error("请先将 Xacro 或带命名空间的文件转换为普通 URDF。");
    for (const child of Array.from(node.children)) inspect(child, depth + 1);
  }
  inspect(root, 0);
  return root;
}

/** 解析视觉与运动树。网格引用在文件导入阶段解析并替换为受控资源 ID。 */
export function parseUrdf(source: string): { robot: SceneRobot; warnings: string[] } {
  const root = parseXml(source);
  const version = root.getAttribute("version");
  if (version !== null && version !== "1.0") throw new Error("场景首版支持 URDF 1.0。");
  const warnings = new Set<string>();
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType !== Node.COMMENT_NODE) continue;
    const comment = node.nodeValue?.trim();
    if (!comment?.startsWith(importNotesPrefix)) continue;
    try {
      const notes: unknown = JSON.parse(comment.slice(importNotesPrefix.length));
      if (Value.Check(SceneWarningsSchema, notes)) {
        for (const note of notes) warnings.add(note);
        break;
      }
    } catch {
      // 普通 XML 注释不影响模型读取。
    }
  }
  const ignored = (node: Element, supported: readonly string[]) => {
    if (Array.from(node.children).some((item) => !supported.includes(item.tagName)))
      warnings.add(`未保留 <${node.tagName}> 中的其他 URDF 元素。`);
  };
  ignored(root, ["link", "joint", "material"]);
  const colorFor = (material: Element | undefined) => {
    if (!material) return undefined;
    ignored(material, ["color"]);
    const color = child(material, "color");
    return color ? vector(attribute(color, "rgba"), 4) : undefined;
  };
  const materials = new Map(
    children(root, "material").map((material) => [attribute(material, "name"), colorFor(material)]),
  );
  const links = children(root, "link").map((link, index) => {
    ignored(link, ["visual"]);
    return {
      id: `link-${index}`,
      name: attribute(link, "name"),
      visuals: children(link, "visual").map((visual) => {
        ignored(visual, ["origin", "geometry", "material"]);
        const material = child(visual, "material");
        const color = colorFor(material) ?? materials.get(material?.getAttribute("name") ?? "");
        return {
          origin: origin(visual),
          geometry: geometry(child(visual, "geometry")),
          ...(color ? { color } : {}),
        };
      }),
    };
  });
  const linkIds = new Map(links.map((link) => [link.name, link.id]));
  const joints = children(root, "joint").map((node, index): SceneJoint => {
    const type = attribute(node, "type");
    if (type !== "fixed" && type !== "revolute" && type !== "continuous" && type !== "prismatic")
      throw new Error(`不支持关节类型：${type}。`);
    if (child(node, "mimic")) throw new Error("首版不支持 mimic 关节。");
    ignored(node, ["parent", "child", "origin", "axis", "limit"]);
    const parentId = linkIds.get(attribute(child(node, "parent"), "link"));
    const childId = linkIds.get(attribute(child(node, "child"), "link"));
    if (!parentId || !childId) throw new Error("关节引用了不存在的 Link。");
    const axis = child(node, "axis");
    const limits = child(node, "limit");
    const bounds =
      type === "revolute" || type === "prismatic"
        ? {
            lower: number(limits?.getAttribute("lower") ?? "0"),
            upper: number(limits?.getAttribute("upper") ?? "0"),
          }
        : undefined;
    const limit =
      limits && type !== "fixed"
        ? {
            ...bounds,
            effort: number(attribute(limits, "effort")),
            velocity: number(attribute(limits, "velocity")),
          }
        : undefined;
    const allowedLimit = bounds ? ["lower", "upper", "effort", "velocity"] : ["effort", "velocity"];
    if (
      limits &&
      (!limit || Array.from(limits.attributes).some(({ name }) => !allowedLimit.includes(name)))
    )
      warnings.add("未保留部分关节限位参数。");
    return {
      id: `joint-${index}`,
      name: attribute(node, "name"),
      type,
      parentId,
      childId,
      origin: origin(node),
      axis: axis ? vector(attribute(axis, "xyz"), 3) : [1, 0, 0],
      position: bounds ? Math.min(bounds.upper, Math.max(bounds.lower, 0)) : 0,
      ...(limit ? { limit } : {}),
    };
  });
  const attached = new Set(joints.map((joint) => joint.childId));
  const roots = links.filter((link) => !attached.has(link.id));
  if (roots.length !== 1 || !roots[0]) throw new Error("URDF 必须有且只有一个根 Link。");
  return {
    robot: { name: attribute(root, "name"), rootLinkId: roots[0].id, links, joints },
    warnings: [...warnings].slice(0, maxSceneWarnings),
  };
}

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
