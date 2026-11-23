import { Matrix4, Object3D } from "three";
import type { SceneDocument, SceneOrigin, SceneRobot } from "../../contracts/scene.ts";
import { coordinates, setOrigin } from "./frames.ts";
import { subtreeLinkIds } from "./tree.ts";

export function originMatrix(origin: SceneOrigin) {
  const object = new Object3D();
  setOrigin(object, origin);
  object.updateMatrix();
  return object.matrix;
}

// 源零件与 Link 的偏移独立保存，修改关节时几何随 Link 运动，不回写 CAD。
export function resolveSceneRobot(document: SceneDocument): SceneRobot | null {
  const { robot, sourceRobot } = document;
  if (!robot?.links.some((link) => link.sourceParts?.length)) return robot;
  const sources = new Map(sourceRobot?.links.map((link) => [link.id, link]));
  return {
    ...robot,
    links: robot.links.map((link) => ({
      ...link,
      visuals: [
        ...link.visuals,
        ...(link.sourceParts ?? []).flatMap((part) => {
          const offset = originMatrix(part.origin);
          return (sources.get(part.sourceId)?.visuals ?? []).map((visual) => ({
            ...visual,
            origin: coordinates(
              new Matrix4().multiplyMatrices(offset, originMatrix(visual.origin)),
            ),
          }));
        }),
      ],
    })),
  };
}

export function sourcePartIds(source: SceneRobot, ids: string[]) {
  const known = new Set(source.links.map((link) => link.id));
  if (ids.some((id) => !known.has(id))) throw new Error("原始零件不存在。");
  const selected = subtreeLinkIds(source, ids);
  return source.links
    .filter((link) => selected.has(link.id) && link.visuals.length > 0)
    .map((link) => link.id);
}
