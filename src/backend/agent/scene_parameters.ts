import { Type } from "typebox";
import type { SceneTransform } from "../../contracts/application.ts";

// 模型接口使用同类型数组；部分提供方不接受 JSON Schema 元组。
export const sceneTransformParameters = Type.Object(
  {
    modelId: Type.String(),
    objectId: Type.String(),
    revision: Type.Integer({ minimum: 0 }),
    position: Type.Array(Type.Number(), { minItems: 3, maxItems: 3 }),
    rotation: Type.Array(Type.Number(), { minItems: 4, maxItems: 4 }),
  },
  { additionalProperties: false },
);

export const jointDraftParameters = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    parentModelId: Type.String(),
    parentObjectId: Type.String(),
    childModelId: Type.String(),
    childObjectId: Type.String(),
    type: Type.Union([Type.Literal("fixed"), Type.Literal("revolute"), Type.Literal("prismatic")]),
    axisOrigin: Type.Optional(Type.Array(Type.Number(), { minItems: 3, maxItems: 3 })),
    axisDirection: Type.Optional(Type.Array(Type.Number(), { minItems: 3, maxItems: 3 })),
  },
  { additionalProperties: false },
);

export const distanceParameters = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    firstModelId: Type.String(),
    firstObjectId: Type.String(),
    secondModelId: Type.String(),
    secondObjectId: Type.String(),
  },
  { additionalProperties: false },
);

export function sceneTransform(position: number[], rotation: number[]): SceneTransform {
  if (
    position.length !== 3 ||
    rotation.length !== 4 ||
    ![...position, ...rotation].every(Number.isFinite)
  )
    throw new Error("位置必须有三个有限数值，旋转必须有四个有限数值。");
  return {
    position: position as SceneTransform["position"],
    rotation: rotation as SceneTransform["rotation"],
  };
}

export function sceneVector(values: number[]): [number, number, number] {
  if (values.length !== 3 || !values.every(Number.isFinite))
    throw new Error("向量必须有三个有限数值。");
  return values as [number, number, number];
}
