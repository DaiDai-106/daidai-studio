import { type Static, Type } from "typebox";
import {
  SceneAssetSchema,
  SceneGeometrySchema,
  SceneOriginSchema,
  SceneRobotSchema,
} from "./scene.ts";
import { id, object } from "./schema.ts";

export const PlanningSourceSchema = Type.Enum(["urdf", "package"]);
export type PlanningSource = Static<typeof PlanningSourceSchema>;
export const PlanningSourcePathSchema = Type.String({ minLength: 1, maxLength: 8192 });
export type PlanningSelection = { kind: PlanningSource; path: string };
export const PlanningZipAttachmentSchema = object({
  // 兼容之前保存为项目副本的聊天记录。
  id: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$" })),
  name: Type.String({ minLength: 1, maxLength: 255 }),
  path: PlanningSourcePathSchema,
});
export type PlanningZipAttachment = Static<typeof PlanningZipAttachmentSchema>;

const xyz = Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);
const sceneObject = object({
  name: id,
  frame: Type.String({ maxLength: 200 }),
  robot: Type.String({ maxLength: 200 }),
  xyz,
  quaternion: Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]),
});
const snapshot = {
  schemaVersion: Type.Literal(1),
  robot: SceneRobotSchema,
  frame: id,
  robots: Type.Array(id, { maxItems: 512 }),
  positioners: Type.Array(id, { maxItems: 512 }),
  groups: Type.Array(object({ name: id, joints: Type.Array(id, { maxItems: 511 }) }), {
    maxItems: 512,
  }),
  collisionGeometry: Type.Array(
    object({ linkId: id, origin: SceneOriginSchema, geometry: SceneGeometrySchema }),
  ),
  objects: Type.Array(sceneObject),
  attachedObjects: Type.Array(sceneObject),
};

export const PlanningWorkerSceneSchema = object({
  ...snapshot,
  assets: Type.Array(
    object({ id: SceneAssetSchema, path: Type.String({ minLength: 1, maxLength: 8192 }) }),
  ),
});

export const PlanningSceneSchema = object({
  ...snapshot,
  revision: id,
  name: Type.String({ minLength: 1, maxLength: 1024 }),
  status: Type.Enum(["loaded", "stale"]),
});
export type PlanningScene = Static<typeof PlanningSceneSchema>;

export const maxPlanningAssetBytes = 32 * 1024 * 1024;
export const planningCommands = {
  "planning.process.get": object({ projectId: id }),
  "planning.process.select": object({ projectId: id, server: Type.Union([id, Type.Null()]) }),
  "planning.load": object({
    projectId: id,
    kind: PlanningSourceSchema,
    path: PlanningSourcePathSchema,
  }),
  "planning.get": object({ projectId: id }),
  "planning.asset": object({ projectId: id, revision: id, asset: SceneAssetSchema }),
  "planning.source.check": object({ requestId: id, kind: PlanningSourceSchema }),
  "planning.source.respond": object({
    requestId: id,
    kind: PlanningSourceSchema,
    path: Type.Optional(PlanningSourcePathSchema),
  }),
};
export const planningResults = {
  "planning.process.get": object({
    selected: Type.Union([id, Type.Null()]),
    servers: Type.Array(object({ id, label: id, disabled: Type.Optional(Type.Literal(true)) })),
    configError: Type.Optional(Type.String({ maxLength: 4000 })),
  }),
  "planning.process.select": Type.Null(),
  "planning.load": Type.Null(),
  "planning.get": Type.Union([PlanningSceneSchema, Type.Null()]),
  "planning.asset": Type.String({ maxLength: 4 * Math.ceil(maxPlanningAssetBytes / 3) }),
  "planning.source.check": Type.Null(),
  "planning.source.respond": Type.Null(),
};
