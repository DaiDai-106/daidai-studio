import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { createSceneService } from "../scene/scene_service.ts";
import {
  distanceParameters,
  jointDraftParameters,
  sceneTransform,
  sceneTransformParameters,
  sceneVector,
} from "./scene_parameters.ts";

export function createSceneTools(projectId: string, scenes: ReturnType<typeof createSceneService>) {
  return [
    defineTool({
      name: "scene_get",
      label: "读取项目场景",
      description: "分页读取当前项目共享场景的对象和版本。",
      parameters: Type.Object(
        {
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input) {
        const scene = scenes.get(projectId);
        const objects = scene.models.flatMap((model) =>
          model.objects
            .filter((object) => !object.deleted)
            .map((object) => {
              const { cylinderCandidates, ...rest } = object;
              return {
                ...rest,
                modelId: model.id,
                cylinderCandidateCount: cylinderCandidates?.length ?? 0,
              };
            }),
        );
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 50;
        const result = {
          projectId: projectId,
          revision: scene.revision,
          models: scene.models.map(({ objects: _objects, ...model }) => model),
          totalObjects: objects.length,
          objects: objects.slice(offset, offset + limit),
          nextOffset: offset + limit < objects.length ? offset + limit : null,
          jointCount: scene.joints.length,
          joints: scene.joints.slice(0, 50),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: {},
        };
      },
    }),
    defineTool({
      name: "scene_list_joints",
      label: "读取关节候选",
      description: "分页读取用户待确认或已确认的关节候选，状态不代表真实机械验证。",
      parameters: Type.Object(
        {
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input) {
        const scene = scenes.get(projectId);
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 25;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                projectId: projectId,
                revision: scene.revision,
                total: scene.joints.length,
                joints: scene.joints.slice(offset, offset + limit),
                nextOffset: offset + limit < scene.joints.length ? offset + limit : null,
              }),
            },
          ],
          details: {},
        };
      },
    }),
    defineTool({
      name: "scene_create_joint_draft",
      label: "创建关节候选草稿",
      description: "创建未经确认的关节草稿；轴线相对父对象，米制，关节类型和限位仍需用户明确确认。",
      parameters: jointDraftParameters,
      async execute(_id, input) {
        if ((input.axisOrigin === undefined) !== (input.axisDirection === undefined))
          throw new Error("关节轴原点和方向必须同时提供。");
        const axis =
          input.axisOrigin && input.axisDirection
            ? {
                origin: sceneVector(input.axisOrigin),
                direction: sceneVector(input.axisDirection),
                unit: "m" as const,
                space: "parent-local" as const,
              }
            : undefined;
        const result = scenes.createJointDraft({
          projectId: projectId,
          revision: input.revision,
          parent: { modelId: input.parentModelId, objectId: input.parentObjectId },
          child: { modelId: input.childModelId, objectId: input.childObjectId },
          type: input.type,
          ...(axis ? { axis } : {}),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                projectId: projectId,
                revision: result.revision,
                joint: result.joints.at(-1),
              }),
            },
          ],
          details: {},
        };
      },
    }),
    defineTool({
      name: "scene_discard_joint_draft",
      label: "放弃关节草稿",
      description: "仅在用户明确要求时放弃待确认草稿；不能移除已确认的关节。",
      parameters: Type.Object(
        { candidateId: Type.String(), revision: Type.Integer({ minimum: 0 }) },
        { additionalProperties: false },
      ),
      async execute(_id, input) {
        const result = scenes.discardJointDraft({
          projectId: projectId,
          candidateId: input.candidateId,
          revision: input.revision,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                projectId: projectId,
                revision: result.revision,
                candidateId: input.candidateId,
              }),
            },
          ],
          details: {},
        };
      },
    }),
    defineTool({
      name: "scene_get_cylinders",
      label: "读取对象圆柱候选",
      description: "分页读取对象的解析圆柱面候选；这只是几何证据，不能直接推断关节。",
      parameters: Type.Object(
        {
          modelId: Type.String(),
          objectId: Type.String(),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input) {
        const scene = scenes.get(projectId);
        const model = scene.models.find((item) => item.id === input.modelId);
        const object = model?.objects.find((item) => item.id === input.objectId && !item.deleted);
        if (!object) throw new Error("场景对象不存在或已删除。");
        const candidates = object.cylinderCandidates ?? [];
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 16;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                projectId: projectId,
                modelId: input.modelId,
                objectId: input.objectId,
                revision: scene.revision,
                total: candidates.length,
                truncated: object.cylinderCandidatesTruncated ?? false,
                candidates: candidates.slice(offset, offset + limit),
                nextOffset: offset + limit < candidates.length ? offset + limit : null,
              }),
            },
          ],
          details: {},
        };
      },
    }),
    defineTool({
      name: "scene_compare_cylinder_axes",
      label: "比较两个圆柱轴线",
      description:
        "比较两个对象的圆柱候选；明确给出角度和距离容差，结果仅是几何证据，不能推断关节或接触。",
      parameters: Type.Object(
        {
          revision: Type.Integer({ minimum: 0 }),
          firstModelId: Type.String(),
          firstObjectId: Type.String(),
          firstFaceIndex: Type.Integer({ minimum: 1 }),
          secondModelId: Type.String(),
          secondObjectId: Type.String(),
          secondFaceIndex: Type.Integer({ minimum: 1 }),
          angleRad: Type.Number({ minimum: 0, maximum: Math.PI / 2 }),
          distanceM: Type.Number({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input) {
        const result = scenes.compareCylinders({
          projectId: projectId,
          revision: input.revision,
          first: {
            modelId: input.firstModelId,
            objectId: input.firstObjectId,
            faceIndex: input.firstFaceIndex,
          },
          second: {
            modelId: input.secondModelId,
            objectId: input.secondObjectId,
            faceIndex: input.secondFaceIndex,
          },
          tolerance: { angleRad: input.angleRad, distanceM: input.distanceM },
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: {},
        };
      },
    }),
    defineTool({
      name: "scene_measure_distance",
      label: "测量两个对象的几何距离",
      description:
        "只读测量当前项目中两个已授权 STEP 几何对象的 OCCT BRep 算法距离。返回米制 Z-up 世界坐标；结果不是碰撞或可靠表面接触判定。",
      parameters: distanceParameters,
      async execute(_id, input, signal) {
        const result = await scenes.measureDistance(
          {
            projectId: projectId,
            revision: input.revision,
            first: { modelId: input.firstModelId, objectId: input.firstObjectId },
            second: { modelId: input.secondModelId, objectId: input.secondObjectId },
          },
          signal ? { signal } : {},
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: {},
        };
      },
    }),
    defineTool({
      name: "scene_set_transform",
      label: "调整场景对象",
      description: "按当前场景版本设置对象在父节点下的局部位置（米）和旋转四元数 xyzw。",
      parameters: sceneTransformParameters,
      async execute(_id, input) {
        const scene = scenes.setTransform({
          projectId: projectId,
          modelId: input.modelId,
          objectId: input.objectId,
          revision: input.revision,
          transform: sceneTransform(input.position, input.rotation),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                projectId: projectId,
                revision: scene.revision,
                modelId: input.modelId,
                objectId: input.objectId,
              }),
            },
          ],
          details: {},
        };
      },
    }),
    defineTool({
      name: "scene_get_bounds",
      label: "读取对象世界边界",
      description: "读取对象在 Z-up 世界坐标系下的保守包围盒，单位为米。",
      parameters: Type.Object(
        { modelId: Type.String(), objectId: Type.String() },
        { additionalProperties: false },
      ),
      async execute(_id, input) {
        const result = scenes.bounds({ projectId: projectId, ...input });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: {},
        };
      },
    }),
    defineTool({
      name: "scene_align_origin",
      label: "将对象对齐原点",
      description: "保持对象旋转，将其世界包围盒最小角移动到世界原点；使用场景版本保护并发修改。",
      parameters: Type.Object(
        {
          modelId: Type.String(),
          objectId: Type.String(),
          revision: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input) {
        const scene = scenes.alignOrigin({ projectId: projectId, ...input });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                projectId: projectId,
                revision: scene.revision,
                modelId: input.modelId,
                objectId: input.objectId,
              }),
            },
          ],
          details: {},
        };
      },
    }),
    defineTool({
      name: "scene_delete_object",
      label: "从场景移除对象",
      description: "在用户明确要求后从场景移除对象及其后代，不修改原 STEP 或显示资源。",
      parameters: Type.Object(
        {
          modelId: Type.String(),
          objectId: Type.String(),
          revision: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input) {
        const scene = scenes.deleteObject({ projectId: projectId, ...input });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                projectId: projectId,
                revision: scene.revision,
                modelId: input.modelId,
                objectId: input.objectId,
              }),
            },
          ],
          details: {},
        };
      },
    }),
  ];
}
