import type { SceneRobot } from "../../contracts/scene.ts";

export function subtreeLinkIds(robot: SceneRobot, ids: Iterable<string>): Set<string> {
  const selected = new Set(ids);
  const children = Map.groupBy(robot.joints, (joint) => joint.parentId);
  for (const id of selected)
    for (const joint of children.get(id) ?? []) selected.add(joint.childId);
  return selected;
}
