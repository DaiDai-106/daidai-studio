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
  kind: Type.Enum(["model_axis", "cad_feature"], { type: "string" }),
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
  alignment_align_min_corner: object({ importId: hash, expectedRevision: Type.Optional(revision) }),
  alignment_align_frame: object({
    importId: hash,
    expectedRevision: revision,
    sourceUp: direction,
    sourceForward: direction,
    anchor: Type.Enum(["reference", "min_corner", "bottom_center"], { type: "string" }),
    sourceOrigin: Type.Optional(point),
    target: frame,
  }),
  alignment_rotate: object({
    importId: hash,
    expectedRevision: revision,
    axis: vector,
    angleDegrees: Type.Number({ minimum: -360000, maximum: 360000 }),
    pivot: vector,
    space: Type.Enum(["world", "model"], { type: "string" }),
  }),
};
const descriptions: Record<keyof typeof AlignmentInputs, string> = {
  alignment_get_bounds:
    "Read world-space rendered mesh bounds, current placement and revision; optionally restrict to an object and descendants. Metres, right-handed Z-up, not exact B-Rep bounds.",
  alignment_align_min_corner:
    "Preserve the current rotation and translate the saved assembly so its world AABB minimum corner is at zero. Returns an absolute placement proposal, not a saved/rendered confirmation.",
  alignment_align_frame:
    "Orient the saved assembly using model axes or cached CAD feature directions, then align a reference point, rotated minimum corner or bottom centre to a target frame. CAD references are object-local; the worker resolves their instance transforms. Returns an absolute rigid placement proposal.",
  alignment_rotate:
    "Rotate the saved assembly about an explicit axis and pivot in world or original model space. Degrees, right-hand rule; expectedRevision guards incremental operations. Returns an absolute placement proposal; never blindly replay an uncertain rotation.",
};
export const AlignmentNativeResultSchema = object({
  before: object({ placement: RigidTransformSchema, bounds: BoundsSchema }),
  after: object({ placement: RigidTransformSchema, bounds: BoundsSchema }),
  resolvedSourceFrame: Type.Optional(frame),
  resolvedTargetFrame: Type.Optional(frame),
  usedReferences: Type.Optional(Type.Array(object({ objectId: text, featureId: text }))),
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
  ...AlignmentNativeResultSchema.properties,
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
  outputSchema: envelope(name === "alignment_get_bounds" ? queryData : changeData),
  description: descriptions[name as keyof typeof AlignmentInputs],
}));
