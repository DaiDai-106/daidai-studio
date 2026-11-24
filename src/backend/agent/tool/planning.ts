import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type PlanningScene,
  type PlanningSelection,
  type PlanningSource,
  PlanningSourcePathSchema,
  PlanningSourceSchema,
} from "../../../contracts/planning.ts";
import { object } from "../../../contracts/schema.ts";
import type { createPlanningService } from "../../module/planning/service.ts";
import { validateFileToolPath } from "../file_access.ts";

export const planningToolNames = {
  load: "planning_load_scene",
  get: "planning_get_scene",
} as const;

function summarize(scene: PlanningScene) {
  return {
    name: scene.name,
    revision: scene.revision,
    robot: scene.robot.name,
    frame: scene.frame,
    robots: scene.robots,
    positioners: scene.positioners,
    groups: scene.groups,
    joints: scene.robot.joints.map(({ name, type, position, limit }) => ({
      name,
      type,
      position,
      limit,
      ...(type === "fixed" ? {} : { unit: type === "prismatic" ? "m" : "rad" }),
    })),
    objects: scene.objects,
    attachedObjects: scene.attachedObjects,
  };
}

function result(value: object) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

export function createPlanningTools(
  planning: ReturnType<typeof createPlanningService>,
  project: { id: string; path: string },
  fullAccess: () => boolean,
  chooseSource: (
    kind?: PlanningSource,
    signal?: AbortSignal,
  ) => Promise<PlanningSelection | undefined>,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: planningToolNames.load,
      label: "加载规划场景",
      description:
        "加载 URDF 文件或 Package 目录。指定 path 时必须同时提供 kind，请求批准模式只接受项目内路径。省略 path 时打开系统选择器。成功后切换当前场景并返回摘要，取消或失败时保留原场景。",
      parameters: object({
        kind: Type.Optional(PlanningSourceSchema),
        path: Type.Optional(PlanningSourcePathSchema),
      }),
      async execute(_callId, { kind, path }, signal) {
        signal?.throwIfAborted();
        let selected: PlanningSelection | undefined;
        if (path === undefined) {
          selected = await chooseSource(kind, signal);
        } else {
          if (!kind) throw new Error("指定路径时请选择 URDF 或 Package 类型。");
          const source = await validateFileToolPath({
            cwd: project.path,
            path,
            write: false,
            literal: true,
            allowOutsideProject: fullAccess(),
          });
          selected = { kind, path: source };
        }
        signal?.throwIfAborted();
        if (!selected) return result({ status: "cancelled" });
        const scene = await planning.load(project.id, selected.kind, selected.path, signal);
        return result({ status: "loaded", scene: summarize(scene) });
      },
    });

    pi.registerTool({
      name: planningToolNames.get,
      label: "读取规划场景",
      description:
        "读取当前项目的规划场景摘要和版本，包括机械臂分组、外部轴、关节状态及已有场景物体。stale 表示规划进程已停止，重新加载后才可继续规划。",
      parameters: object({}),
      async execute(_callId, _input, signal) {
        const scene = await planning.get(project.id, signal);
        return scene
          ? result({ status: scene.status, scene: summarize(scene) })
          : result({ status: "empty" });
      },
    });
  };
}
