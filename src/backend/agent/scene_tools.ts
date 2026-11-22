import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  JointPositionSchema,
  SceneRevisionSchema,
  StepAttachmentIdSchema,
} from "../../contracts/scene.ts";
import { object } from "../../contracts/schema.ts";
import { jointPosition } from "../scene/document.ts";
import type { createSceneService } from "../scene/service.ts";

export const sceneToolNames = {
  get: "scene_get",
  setPosition: "scene_set_joint_position",
  importStep: "scene_import_step",
} as const;

export function createSceneTools(
  scene: ReturnType<typeof createSceneService>,
  projectId: string,
  fullAccess: () => boolean,
): ExtensionFactory {
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  });
  return (pi) => {
    pi.registerTool({
      name: sceneToolNames.get,
      label: "读取场景",
      description: "读取当前机器人和版本，返回关节 ID、位置、限位和连杆关系。改关节前先调用。",
      parameters: object({ jointName: Type.Optional(Type.String({ maxLength: 200 })) }),
      async execute(_callId, { jointName }) {
        const { document, legacy } = await scene.get(projectId);
        const robot = document.robot;
        const links = new Map(robot?.links.map(({ id, name }) => [id, name]));
        return result({
          revision: document.revision,
          legacy,
          robot: robot?.name ?? null,
          joints:
            robot?.joints
              .filter((joint) => !jointName || joint.name === jointName)
              .map((joint) => ({
                id: joint.id,
                name: joint.name,
                type: joint.type,
                axis: joint.axis,
                position: joint.position,
                parent: links.get(joint.parentId),
                child: links.get(joint.childId),
                limit: joint.limit,
                unit: joint.type === "prismatic" ? "m" : "rad",
              })) ?? [],
        });
      },
    });
    pi.registerTool({
      name: sceneToolNames.importStep,
      label: "导入 STEP 附件",
      description:
        "将用户消息中的 STEP 附件导入当前场景。成功后替换原装配。attachmentId 来自 [STEP 附件]，expectedRevision 来自 scene_get。",
      parameters: object({
        attachmentId: StepAttachmentIdSchema,
        expectedRevision: SceneRevisionSchema,
      }),
      async execute(_callId, { attachmentId, expectedRevision }, signal) {
        signal?.throwIfAborted();
        const snapshot = await scene.importStepAttachment(
          projectId,
          expectedRevision,
          attachmentId,
          signal,
        );
        const robot = snapshot.document.robot;
        return result({
          revision: snapshot.document.revision,
          robot: robot?.name,
          linkCount: robot?.links.length,
          warnings: snapshot.document.warnings,
        });
      },
    });
    pi.registerTool({
      name: sceneToolNames.setPosition,
      label: "调整场景关节",
      description:
        "修改当前场景的关节位置。转动关节用弧度，移动关节用米。expectedRevision 必须来自 scene_get。",
      parameters: JointPositionSchema,
      async execute(_callId, { jointId, position, expectedRevision }, signal, _onUpdate, context) {
        signal?.throwIfAborted();
        const { document } = await scene.get(projectId);
        signal?.throwIfAborted();
        if (document.revision !== expectedRevision) throw new Error("场景已更新，请重新读取。");
        const joint = document.robot?.joints.find((joint) => joint.id === jointId);
        if (!joint) throw new Error("关节不存在。");
        jointPosition(joint, position);
        if (position !== joint.position && !fullAccess()) {
          const approved = await context.ui.confirm(
            "允许调整场景关节？",
            `${joint.name}：${joint.position} → ${position} ${joint.type === "prismatic" ? "m" : "rad"}`,
            signal ? { signal } : undefined,
          );
          if (!approved) throw new Error("场景关节调整已取消。");
        }
        const snapshot = await scene.apply(
          projectId,
          expectedRevision,
          { op: "setJointPosition", jointId, position },
          signal,
        );
        return result({ revision: snapshot.document.revision, jointId, position });
      },
    });
  };
}
