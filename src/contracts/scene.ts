import { type Static, Type } from "typebox";
import { id, object } from "./schema.ts";

export const maxUrdfBytes = 1_048_576;
export const maxSceneAssetBytes = 8_388_608;
export const maxStepBytes = 128 * 1024 * 1024;
export const maxSceneWarnings = 20;
export const SceneWarningsSchema = Type.Array(id, { maxItems: maxSceneWarnings });
export type SceneImportFormat = "step" | "step-source" | "urdf";
export const StepAttachmentIdSchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export const StepAttachmentSchema = object({
  id: StepAttachmentIdSchema,
  name: Type.String({ minLength: 1, maxLength: 255 }),
});
export type StepAttachment = Static<typeof StepAttachmentSchema>;
export const SceneRevisionSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const SceneAssetSchema = Type.String({ pattern: "^[a-f0-9]{64}\\.stl$" });
export const sceneJointTypes = ["fixed", "revolute", "continuous", "prismatic"] as const;
const JointTypeSchema = Type.Enum(sceneJointTypes);
export const JointPositionSchema = object({
  jointId: id,
  position: Type.Number(),
  expectedRevision: SceneRevisionSchema,
});
export type SceneJointPreview = Pick<Static<typeof JointPositionSchema>, "jointId" | "position">;
const number = Type.Number();
const positive = Type.Number({ exclusiveMinimum: 0 });
const vec3 = Type.Tuple([number, number, number]);
export const SceneOriginSchema = object({ xyz: vec3, rpy: vec3 });
const channel = Type.Number({ minimum: 0, maximum: 1 });
const geometry = Type.Union([
  object({ type: Type.Literal("box"), size: Type.Tuple([positive, positive, positive]) }),
  object({ type: Type.Literal("sphere"), radius: positive }),
  object({ type: Type.Literal("cylinder"), radius: positive, length: positive }),
  object({ type: Type.Literal("mesh"), asset: SceneAssetSchema, scale: vec3 }),
]);
const visual = object({
  origin: SceneOriginSchema,
  geometry,
  color: Type.Optional(Type.Tuple([channel, channel, channel, channel])),
});
const link = object({
  id,
  name: id,
  visuals: Type.Array(visual, { maxItems: 16384 }),
  sourceParts: Type.Optional(
    Type.Array(object({ sourceId: id, origin: SceneOriginSchema }), { maxItems: 512 }),
  ),
});
const joint = object({
  id,
  name: id,
  type: JointTypeSchema,
  parentId: id,
  childId: id,
  origin: SceneOriginSchema,
  axis: vec3,
  limit: Type.Optional(
    object({
      lower: Type.Optional(number),
      upper: Type.Optional(number),
      effort: Type.Number({ minimum: 0 }),
      velocity: Type.Number({ minimum: 0 }),
    }),
  ),
  position: number,
});

const SceneRobotSchema = object({
  name: id,
  rootLinkId: id,
  links: Type.Array(link, { minItems: 1, maxItems: 512 }),
  joints: Type.Array(joint, { maxItems: 511 }),
});
const transparencyValue = Type.Integer({ minimum: 0, maximum: 100 });
const SceneTransparencySchema = object({
  entity: Type.Enum(["source", "link"]),
  id,
  value: transparencyValue,
});
export type SceneTransparency = Static<typeof SceneTransparencySchema>;
export type SceneVisualOpacities = ReadonlyMap<string, readonly number[]>;
export const SceneDocumentSchema = object({
  schemaVersion: Type.Literal(1),
  revision: SceneRevisionSchema,
  robot: Type.Union([SceneRobotSchema, Type.Null()]),
  sourceRobot: Type.Optional(SceneRobotSchema),
  sourceWarnings: Type.Optional(SceneWarningsSchema),
  warnings: SceneWarningsSchema,
  transparencies: Type.Optional(Type.Array(SceneTransparencySchema, { maxItems: 1024 })),
});
export const SceneSnapshotSchema = object({
  document: SceneDocumentSchema,
  canUndo: Type.Boolean(),
  sourceRevision: SceneRevisionSchema,
});
const entity = Type.Enum(["link", "joint"]);
export const SceneOperationSchema = Type.Union([
  object({ op: Type.Literal("setJointPosition"), jointId: id, position: number }),
  object({ op: Type.Literal("rename"), entity, id, name: id }),
  object({
    op: Type.Literal("addChildLink"),
    parentId: id,
    linkName: id,
    jointName: id,
    jointType: JointTypeSchema,
  }),
  object({
    op: Type.Literal("updateJoint"),
    jointId: id,
    name: id,
    parentId: id,
    jointType: JointTypeSchema,
    origin: SceneOriginSchema,
    axis: vec3,
    limit: Type.Optional(joint.properties.limit),
  }),
  object({
    op: Type.Literal("assignSource"),
    sourceIds: Type.Array(id, { minItems: 1, maxItems: 512 }),
    linkId: id,
  }),
  object({
    op: Type.Literal("createSourceLink"),
    sourceIds: Type.Array(id, { minItems: 1, maxItems: 512 }),
    parentId: id,
    linkName: id,
    jointName: id,
    jointType: JointTypeSchema,
  }),
  object({
    op: Type.Literal("unassignSource"),
    sourceIds: Type.Array(id, { minItems: 1, maxItems: 512 }),
  }),
  object({
    op: Type.Literal("setTransparency"),
    entity: SceneTransparencySchema.properties.entity,
    ids: Type.Array(id, { minItems: 1, maxItems: 512 }),
    value: transparencyValue,
  }),
  object({ op: Type.Literal("removeSubtree"), linkId: id }),
  object({ op: Type.Literal("undo") }),
]);

export type SceneDocument = Static<typeof SceneDocumentSchema>;
export type SceneSnapshot = Static<typeof SceneSnapshotSchema>;
export type SceneRobot = Static<typeof SceneRobotSchema>;
export type SceneJoint = Static<typeof joint>;
export type SceneVisual = Static<typeof visual>;
export type SceneOrigin = Static<typeof SceneOriginSchema>;
export type SceneOperation = Static<typeof SceneOperationSchema>;
export type SceneSelection = Pick<Extract<SceneOperation, { op: "rename" }>, "entity" | "id">;
