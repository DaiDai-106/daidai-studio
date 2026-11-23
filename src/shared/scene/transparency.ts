import type {
  SceneDocument,
  SceneTransparency,
  SceneVisualOpacities,
} from "../../contracts/scene.ts";
import { sourcePartIds } from "./geometry.ts";
import { subtreeLinkIds } from "./tree.ts";

type Target = Pick<SceneTransparency, "entity" | "id">;
export const transparencyKey = ({ entity, id }: Target) => `${entity}:${id}`;

export function transparencyTargets(
  document: SceneDocument,
  entity: Target["entity"],
  ids: string[],
): Target[] {
  if (entity === "source") {
    if (!document.sourceRobot) throw new Error("请先导入原始模型。");
    return sourcePartIds(document.sourceRobot, ids).map((id) => ({ entity, id }));
  }
  const robot = document.robot;
  if (!robot) throw new Error("请先导入场景。");
  if (ids.some((id) => !robot.links.some((link) => link.id === id)))
    throw new Error("Link 不存在。");
  const selected = subtreeLinkIds(robot, ids);
  return robot.links
    .filter((link) => selected.has(link.id))
    .flatMap((link): Target[] => [
      ...(link.visuals.length ? [{ entity: "link" as const, id: link.id }] : []),
      ...(link.sourceParts ?? []).map((part) => ({ entity: "source" as const, id: part.sourceId })),
    ]);
}

export function selectionTransparency(document: SceneDocument, targets: Target[]) {
  const settings = new Map(
    document.transparencies?.map((setting) => [transparencyKey(setting), setting.value]),
  );
  const values = new Set(targets.map((target) => settings.get(transparencyKey(target)) ?? 0));
  return {
    value: values.size === 1 ? (values.values().next().value ?? 0) : 0,
    mixed: values.size > 1,
  };
}

// CAD 零件是绑定几何的显示设置来源，Link 设置只用于其原生 URDF 几何。
export function sceneVisualOpacities(
  document: SceneDocument,
  sourceView: boolean,
  draft: SceneTransparency[] = [],
): SceneVisualOpacities {
  const settings = new Map(
    document.transparencies?.map((setting) => [transparencyKey(setting), setting.value]),
  );
  for (const setting of draft) settings.set(transparencyKey(setting), setting.value);
  const opacity = (entity: Target["entity"], id: string) =>
    1 - (settings.get(transparencyKey({ entity, id })) ?? 0) / 100;
  const sources = new Map(document.sourceRobot?.links.map((link) => [link.id, link]));
  return new Map(
    (sourceView ? document.sourceRobot?.links : document.robot?.links)?.map((link) => [
      link.id,
      [
        ...link.visuals.map(() => opacity(sourceView ? "source" : "link", link.id)),
        ...(sourceView
          ? []
          : (link.sourceParts ?? []).flatMap(
              (part) =>
                sources.get(part.sourceId)?.visuals.map(() => opacity("source", part.sourceId)) ??
                [],
            )),
      ],
    ]) ?? [],
  );
}
