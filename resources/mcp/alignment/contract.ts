import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const text = Type.String({ minLength: 1, maxLength: 1000 });
const coordinate = Type.Number({ minimum: -1e9, maximum: 1e9 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const TranslationSchema = Type.Tuple([coordinate, coordinate, coordinate]);
export const RotationSchema = Type.Tuple([
  Type.Number(),
  Type.Number(),
  Type.Number(),
  Type.Number(),
]);
export const RigidTransformSchema = object({
  translation: TranslationSchema,
  rotation: RotationSchema,
});
export const BoundsSchema = object({ min: TranslationSchema, max: TranslationSchema });
const changeFields = {
  importId: hash,
  sourceHash: hash,
  expectedRevision: revision,
  translation: TranslationSchema,
};
const legacyChange = object(changeFields);
export const PlacementChangeSchema = object({
  ...changeFields,
  schemaVersion: Type.Literal(2),
  rotation: RotationSchema,
});
export type PlacementChange = Static<typeof PlacementChangeSchema>;
const placementFields = {
  importId: hash,
  sourceHash: hash,
  revision,
  translation: TranslationSchema,
};
const legacyPlacement = object({ ...placementFields, schemaVersion: Type.Literal(1) });
export const PlacementSchema = object({
  ...placementFields,
  schemaVersion: Type.Literal(2),
  rotation: RotationSchema,
});
export type Placement = Static<typeof PlacementSchema>;

export function validRotation(value: number[]) {
  return value.every(Number.isFinite) && Math.abs(Math.hypot(...value) - 1) <= 1e-6;
}
// Decode historical files AND committed tool results without rewriting the durable journal.
export function decodePlacement(value: unknown): Placement | undefined {
  if (Value.Check(PlacementSchema, value)) return validRotation(value.rotation) ? value : undefined;
  if (Value.Check(legacyPlacement, value))
    return { ...value, schemaVersion: 2, rotation: [0, 0, 0, 1] };
  return undefined;
}
export function decodePlacementChange(value: unknown): PlacementChange | undefined {
  if (Value.Check(PlacementChangeSchema, value))
    return validRotation(value.rotation) ? value : undefined;
  if (Value.Check(legacyChange, value))
    return { ...value, schemaVersion: 2, rotation: [0, 0, 0, 1] };
  return undefined;
}
// Homogeneous array schemas stay portable across model providers; tuples are output-only.
const vector = Type.Array(coordinate, { minItems: 3, maxItems: 3 });
const direction = object({
  kind: Type.Enum(["model_axis", "world_axis", "cad_feature"], { type: "string" }),
  axis: Type.Optional(Type.Enum(["X", "Y", "Z"], { type: "string" })),
  objectId: Type.Optional(text),
  featureId: Type.Optional(text),
  reverse: Type.Optional(Type.Boolean()),
});
const point = object({
  kind: Type.Enum(["model_point", "cad_feature"], { type: "string" }),
  position: Type.Optional(vector),
  objectId: Type.Optional(text),
  featureId: Type.Optional(text),
});
const frame = object({ origin: vector, up: vector, forward: vector });
export const AlignmentInputs = {
  alignment_get_bounds: object({ importId: hash, objectId: Type.Optional(text) }),
  // Existing clients may omit revision; new skills always supply it.
  alignment_align_min_corner: object({
    importId: hash,
    expectedRevision: Type.Optional(revision),
    preview: Type.Optional(Type.Boolean()),
  }),
  alignment_align_frame: object({
    importId: hash,
    expectedRevision: revision,
    preview: Type.Optional(Type.Boolean()),
    sourceUp: direction,
    sourceForward: direction,
    anchor: Type.Enum(["reference", "min_corner", "bottom_center"], { type: "string" }),
    sourceOrigin: Type.Optional(point),
    target: frame,
  }),
  alignment_rotate: object({
    importId: hash,
    expectedRevision: revision,
    preview: Type.Optional(Type.Boolean()),
    axis: vector,
    angleDegrees: Type.Number({ minimum: -360000, maximum: 360000 }),
    pivot: vector,
    space: Type.Enum(["world", "model"], { type: "string" }),
  }),
  alignment_align_direction: object({
    importId: hash,
    expectedRevision: revision,
    preview: Type.Optional(Type.Boolean()),
    sourceDirection: direction,
    targetDirection: vector,
    pivot: object({
      kind: Type.Enum(["bounds_center", "world_point"], { type: "string" }),
      position: Type.Optional(vector),
    }),
  }),
  alignment_ground: object({
    importId: hash,
    expectedRevision: revision,
    preview: Type.Optional(Type.Boolean()),
    groundZ: coordinate,
    contacts: Type.Array(object({ objectId: text, featureId: text }), { minItems: 1, maxItems: 4 }),
  }),
  scene_inspect: object({
    importId: hash,
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    objectIds: Type.Optional(Type.Array(text, { maxItems: 4 })),
    order: Type.Optional(Type.Enum(["lowest"], { type: "string" })),
  }),
  scene_get_features: object({
    importId: hash,
    objectIds: Type.Array(text, { minItems: 1, maxItems: 4 }),
    type: Type.Optional(text),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  }),
  scene_find_features: object({
    importId: hash,
    type: Type.Optional(Type.Enum(["plane_center", "cylinder_axis"], { type: "string" })),
    worldAxis: Type.Optional(Type.Enum(["X", "Y", "Z"], { type: "string" })),
    minAbsCos: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    minWorldZ: Type.Optional(coordinate),
    maxWorldZ: Type.Optional(coordinate),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  }),
};
const descriptions: Record<keyof typeof AlignmentInputs, string> = {
  alignment_get_bounds:
    "Read world-space rendered mesh bounds, current placement and revision; optionally restrict to an object and descendants. Metres, right-handed Z-up, not exact B-Rep bounds.",
  alignment_align_min_corner:
    "Preserve the current rotation and translate the saved assembly so its world AABB minimum corner is at zero. Returns an absolute placement proposal, not a saved/rendered confirmation. Use preview=true and expectedRevision to calculate without applying.",
  alignment_align_frame:
    "Orient the saved assembly using model/world axes or cached CAD feature directions, then align a reference point, rotated minimum corner or bottom centre to a target frame. CAD references are object-local; the worker resolves their instance transforms. Returns an absolute rigid placement proposal. Use preview=true to calculate without applying.",
  alignment_rotate:
    "Rotate the saved assembly about an explicit axis and pivot in world or original model space. Degrees, right-hand rule; expectedRevision guards incremental operations. Returns an absolute placement proposal; never blindly replay an uncertain rotation. Use preview=true to calculate without applying.",
  alignment_align_direction:
    "Map one model axis, current world axis, or cached CAD feature direction onto a world-space target with the minimum rotation. For an axis observed in overview, use world_axis. Pivot is the current world display bounds center or an explicit world point. Does not choose a front direction or move the model to the floor. Use preview=true to calculate without applying.",
  alignment_ground:
    "Translate only world Z so the lowest selected horizontal CAD contact plane reaches groundZ. Supply identified foot plane references. Returns every contact height; if they differ, do not claim all feet touch the ground. Preserves X/Y and rotation. Use preview=true to calculate without applying.",
  scene_inspect:
    "Inspect the saved assembly without reopening STEP. Use order=lowest to list mesh objects by world minimum Z with each world bound, helping find feet after orienting. Use objectIds for details and cached feature references. Geometry and names do not establish semantic orientation.",
  scene_get_features:
    "List cached CAD features for up to four saved objects, with origins and directions resolved to world coordinates at the current placement. Filter by type and paginate per object; use returned featureId directly for alignment or ground contact. No shell or coordinate conversion needed.",
  scene_find_features:
    "Find cached plane centers or cylinder axes across the saved scene, filter by world axis alignment and origin height, and paginate. Results are geometric evidence, not semantic identification of feet or lifting lugs. Origins do not describe a feature's complete extent.",
};
export const AlignmentNativeResultSchema = object({
  before: object({ placement: RigidTransformSchema, bounds: BoundsSchema }),
  after: object({ placement: RigidTransformSchema, bounds: BoundsSchema }),
  resolvedSourceFrame: Type.Optional(frame),
  resolvedTargetFrame: Type.Optional(frame),
  usedReferences: Type.Optional(Type.Array(object({ objectId: text, featureId: text }))),
  resolvedDirection: Type.Optional(
    object({
      source: TranslationSchema,
      target: TranslationSchema,
      axis: TranslationSchema,
      angleDegrees: Type.Number(),
      pivot: TranslationSchema,
    }),
  ),
  groundContacts: Type.Optional(
    Type.Array(
      object({ objectId: text, featureId: text, beforeZ: coordinate, afterZ: coordinate }),
      { minItems: 1, maxItems: 4 },
    ),
  ),
});
const commonData = {
  importId: hash,
  sourceHash: hash,
  unit: Type.Literal("m"),
  boundsKind: Type.Literal("display-mesh"),
  warnings: Type.Array(Type.String()),
};
const queryData = object({
  ...commonData,
  revision,
  space: Type.Literal("world"),
  objectId: Type.Optional(text),
  placement: RigidTransformSchema,
  bounds: BoundsSchema,
});
const changeData = object({
  ...commonData,
  baseRevision: revision,
  preview: Type.Optional(Type.Literal(true)),
  ...AlignmentNativeResultSchema.properties,
});
const summaryBounds = Type.Union([BoundsSchema, object({ error: Type.String() })]);
export const SceneSummarySchema = object({
  importId: hash,
  revision,
  unit: Type.Literal("m"),
  coordinateSystem: object({
    unit: Type.Literal("m"),
    upAxis: Type.Literal("Z"),
    handedness: Type.Literal("right"),
    gltfConversion: Type.Literal("x,z,-y"),
  }),
  placement: PlacementSchema,
  bounds: summaryBounds,
  objectCount: Type.Integer({ minimum: 0 }),
  objects: Type.Array(
    object({
      objectId: text,
      name: Type.String(),
      kind: Type.Enum(["assembly", "shape"], { type: "string" }),
      parentObjectId: Type.Optional(text),
      localTransform: Type.Optional(
        object({ translation: vector, rotation: Type.Array(Type.Number()), scale: vector }),
      ),
      bounds: Type.Optional(summaryBounds),
      features: Type.Optional(Type.Array(Type.Unknown())),
      featureCount: Type.Optional(Type.Integer({ minimum: 0 })),
      featureStartLine: Type.Optional(Type.Integer({ minimum: 1 })),
      featuresComplete: Type.Optional(Type.Boolean()),
    }),
  ),
  nextOffset: Type.Optional(Type.Integer({ minimum: 0 })),
  complete: Type.Boolean(),
  warnings: Type.Array(Type.String()),
  featureNote: Type.String(),
});
export const SceneFeaturesSchema = object({
  importId: hash,
  revision,
  unit: Type.Literal("m"),
  space: Type.Literal("world"),
  objects: Type.Array(
    object({
      objectId: text,
      total: Type.Integer({ minimum: 0 }),
      features: Type.Array(
        object({
          featureId: text,
          type: text,
          origin: vector,
          direction: Type.Optional(vector),
          radius: Type.Optional(Type.Number()),
        }),
        { maxItems: 50 },
      ),
      nextOffset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    { minItems: 1, maxItems: 4 },
  ),
});
export const SceneFeatureCandidatesSchema = object({
  importId: hash,
  revision,
  unit: Type.Literal("m"),
  space: Type.Literal("world"),
  total: Type.Integer({ minimum: 0 }),
  nextOffset: Type.Optional(Type.Integer({ minimum: 0 })),
  featureCacheComplete: Type.Boolean(),
  displayComplete: Type.Boolean(),
  features: Type.Array(
    object({
      objectId: text,
      featureId: text,
      type: text,
      origin: vector,
      direction: Type.Optional(vector),
      radius: Type.Optional(Type.Number()),
    }),
    { maxItems: 50 },
  ),
});
const envelope = (data: import("typebox").TSchema) => ({
  ...Type.Union([
    object({ ok: Type.Literal(true), data }),
    object({
      ok: Type.Literal(false),
      error: object({ code: Type.String(), message: Type.String() }),
      currentPlacement: Type.Optional(PlacementSchema),
    }),
  ]),
  type: "object" as const,
});
export const alignmentTools = Object.entries(AlignmentInputs).map(([name, inputSchema]) => ({
  name,
  inputSchema: { ...inputSchema, type: "object" as const },
  outputSchema:
    name === "scene_inspect" || name === "scene_get_features" || name === "scene_find_features"
      ? {
          ...(name === "scene_inspect"
            ? SceneSummarySchema
            : name === "scene_get_features"
              ? SceneFeaturesSchema
              : SceneFeatureCandidatesSchema),
          type: "object" as const,
        }
      : envelope(name === "alignment_get_bounds" ? queryData : changeData),
  description: descriptions[name as keyof typeof AlignmentInputs],
}));
