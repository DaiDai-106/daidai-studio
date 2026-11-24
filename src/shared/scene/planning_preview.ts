import type { PlanningScene } from "../../contracts/planning.ts";
import type { SceneRobot, SceneVisual } from "../../contracts/scene.ts";

/** 预览把超出限位的默认零位移到最近限位，保留 One Punch 的实际状态。 */
export function planningPreviewRobot(
  robot: SceneRobot,
  collisionGeometry?: PlanningScene["collisionGeometry"],
): SceneRobot {
  const collisionsByLink = new Map<string, SceneVisual[]>();
  for (const { linkId, origin, geometry } of collisionGeometry ?? []) {
    const visuals = collisionsByLink.get(linkId) ?? [];
    visuals.push({ origin, geometry, color: [0.86, 0.33, 0.12, 1] });
    collisionsByLink.set(linkId, visuals);
  }
  return {
    ...robot,
    links: collisionGeometry
      ? robot.links.map((link) => ({ ...link, visuals: collisionsByLink.get(link.id) ?? [] }))
      : robot.links,
    joints: robot.joints.map((joint) => {
      if (joint.position !== 0 || !joint.limit) return joint;
      const { lower, upper } = joint.limit;
      if (lower !== undefined && lower > 0) return { ...joint, position: lower };
      if (upper !== undefined && upper < 0) return { ...joint, position: upper };
      return joint;
    }),
  };
}
