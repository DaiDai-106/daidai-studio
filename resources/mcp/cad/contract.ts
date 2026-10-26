import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const text = (maxLength = 200) => Type.String({ minLength: 1, maxLength });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const number = Type.Number();
// Homogeneous fixed-length arrays also work with model providers' tool schemas.
const vector = Type.Array(number, { minItems: 3, maxItems: 3 });
const rgba = Type.Array(Type.Number({ minimum: 0, maximum: 1 }), {
  minItems: 4,
  maxItems: 4,
});
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const page = {
  cursor: Type.Optional(text(1000)),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
};
export const CadHandleSchema = object({ serverInstanceId: text(), id: text() });
export type CadHandle = Static<typeof CadHandleSchema>;
export const CadTopologySchema = object({
  kind: Type.Enum(["face", "edge", "vertex"], { type: "string" }),
  id: text(),
});
export const CadTransformSchema = object({
  translation: vector,
  rotation: Type.Array(number, { minItems: 4, maxItems: 4 }),
  scale: vector,
});
export const CadResourceSchema = object({
  uri: text(8192),
  mediaType: text(),
  byteLength: count,
  sha256: hash,
});
export type CadResource = Static<typeof CadResourceSchema>;
export const CadQualitySchema = Type.Enum(["preview", "standard", "fine"], { type: "string" });
export type CadQuality = Static<typeof CadQualitySchema>;
export const CadFeatureTypeSchema = Type.Enum(
  ["plane_center", "circle_center", "cylinder_axis", "edge_midpoint", "vertex"],
  { type: "string" },
);
const warnings = Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 100 });
export const CadPropertyFieldsSchema = Type.Array(
  Type.Enum(["bounds", "topology", "appearance", "validity", "measures"], { type: "string" }),
  {
    minItems: 1,
    maxItems: 5,
  },
);
const error = object({
  code: text(),
  message: Type.String({ maxLength: 2000 }),
  objectId: Type.Optional(text()),
  topologyRef: Type.Optional(CadTopologySchema),
});
const unavailable = object({ status: Type.Literal("unavailable"), reason: text() });
const property = <T extends TSchema>(value: T) =>
  Type.Union([object({ status: Type.Literal("exact"), value }), unavailable]);
export const CadObjectSchema = object({
  objectId: text(),
  sourceKey: text(4096),
  parentObjectId: Type.Optional(text()),
  name: Type.String({ maxLength: 1000 }),
  kind: Type.Enum(["assembly", "shape"]),
  geometryId: Type.Optional(text()),
  localTransform: CadTransformSchema,
  childCount: count,
});
export type CadObject = Static<typeof CadObjectSchema>;
export const CadObjectPageSchema = object({
  items: Type.Array(CadObjectSchema, { maxItems: 200 }),
  nextCursor: Type.Optional(text(1000)),
});
const featureBase = {
  featureId: text(),
  objectId: text(),
  topologyRef: CadTopologySchema,
  origin: vector,
  provenance: Type.Literal("cad"),
};
export const CadFeatureSchema = Type.Union([
  object({ ...featureBase, type: Type.Literal("plane_center"), direction: vector }),
  object({
    ...featureBase,
    type: Type.Literal("circle_center"),
    direction: vector,
    radius: number,
  }),
  object({
    ...featureBase,
    type: Type.Literal("cylinder_axis"),
    direction: vector,
    radius: number,
  }),
  object({ ...featureBase, type: Type.Literal("edge_midpoint") }),
  object({ ...featureBase, type: Type.Literal("vertex") }),
]);
export type CadFeature = Static<typeof CadFeatureSchema>;
export const CadDistanceSchema = object({
  firstObjectId: text(),
  secondObjectId: text(),
  method: Type.Literal("occt_brep_extrema"),
  space: Type.Literal("query"),
  unit: Type.Literal("m"),
  distance: Type.Number({ minimum: 0 }),
  deflection: Type.Number({ exclusiveMinimum: 0 }),
  innerSolution: Type.Boolean(),
  solutionCount: Type.Integer({ minimum: 1 }),
  truncated: Type.Boolean(),
  solutions: Type.Array(object({ first: vector, second: vector }), { minItems: 1, maxItems: 20 }),
});
export type CadDistance = Static<typeof CadDistanceSchema>;
const measure = (unit: "m2" | "m3") =>
  Type.Union([
    unavailable,
    object({
      status: Type.Literal("computed"),
      value: object({
        amount: Type.Number({ exclusiveMinimum: 0 }),
        unit: Type.Literal(unit),
        centroid: vector,
        relativeErrorEstimate: Type.Number({ minimum: 0 }),
      }),
    }),
  ]);
export const CadPropertySchema = object({
  objectId: text(),
  measures: Type.Optional(
    Type.Union([
      unavailable,
      object({
        status: Type.Literal("computed"),
        value: object({
          method: Type.Literal("occt_brep_gprop"),
          space: Type.Literal("object"),
          semantics: Type.Literal("topological_sum"),
          requestedRelativeError: Type.Number({ exclusiveMinimum: 0 }),
          surface: measure("m2"),
          volume: measure("m3"),
        }),
      }),
    ]),
  ),
  validity: Type.Optional(
    property(
      object({
        valid: Type.Boolean(),
        method: Type.Literal("occt_brep_check"),
        curveOnSurfaceMethod: Type.Literal("exact_when_same_parameter"),
        issueCount: count,
        truncated: Type.Boolean(),
        issues: Type.Array(
          object({
            shapeType: Type.Enum([
              "compound",
              "compsolid",
              "solid",
              "shell",
              "face",
              "wire",
              "edge",
              "vertex",
              "shape",
            ]),
            code: text(200),
            topologyRef: Type.Optional(CadTopologySchema),
          }),
          { maxItems: 50 },
        ),
      }),
    ),
  ),
  bounds: Type.Optional(
    property(
      object({ min: vector, max: vector, unit: Type.Literal("m"), space: Type.Literal("object") }),
    ),
  ),
  topology: Type.Optional(
    property(
      object({
        vertexCount: count,
        edgeCount: count,
        faceCount: count,
        shellCount: count,
        solidCount: count,
      }),
    ),
  ),
  appearance: Type.Optional(
    property(
      object({
        objectColor: Type.Optional(rgba),
        hasFaceColors: Type.Boolean(),
        faceColorCount: count,
      }),
    ),
  ),
});
export type CadProperty = Static<typeof CadPropertySchema>;
// Values describe the private source bytes and import settings, not desktop identities.
export const SourceVersionSchema = object({
  path: text(4096),
  sourceHash: hash,
  importFingerprint: hash,
  sourceLengthUnits: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 100 }),
});
export type SourceVersion = Static<typeof SourceVersionSchema>;
export const CadImportSchema = object({
  document: CadHandleSchema,
  source: SourceVersionSchema,
  outputLengthUnit: Type.Literal("m"),
  objectCount: count,
  rootObjectCount: count,
  warnings,
});
export type CadImport = Static<typeof CadImportSchema>;
const displaySummary = object({
  source: SourceVersionSchema,
  complete: Type.Boolean(),
  objectCount: count,
  geometryCount: count,
  triangleCount: count,
  warningCount: count,
  omittedFaceCount: Type.Optional(count),
});
export const CadDisplaySchema = object({ manifest: CadResourceSchema, summary: displaySummary });
export type CadDisplay = Static<typeof CadDisplaySchema>;
const status = Type.Enum(["queued", "running", "cancelling", "succeeded", "failed", "cancelled"]);
const jobBase = { job: CadHandleSchema };
const activeJob = object({
  ...jobBase,
  kind: Type.Enum(["import", "display"]),
  status: Type.Enum(["queued", "running", "cancelling"]),
  phase: Type.Optional(text()),
  progress: Type.Optional(object({ completed: number, total: number, unit: text() })),
});
export const CadJobSchema = Type.Union([
  activeJob,
  object({
    ...jobBase,
    kind: Type.Literal("import"),
    status: Type.Literal("succeeded"),
    result: CadImportSchema,
  }),
  object({
    ...jobBase,
    kind: Type.Literal("display"),
    status: Type.Literal("succeeded"),
    result: CadDisplaySchema,
  }),
  object({
    ...jobBase,
    kind: Type.Enum(["import", "display"]),
    status: Type.Literal("failed"),
    error,
  }),
  object({
    ...jobBase,
    kind: Type.Enum(["import", "display"]),
    status: Type.Literal("cancelled"),
  }),
]);
export type CadJob = Static<typeof CadJobSchema>;
export const CadLimitsSchema = object({
  maxFileBytes: count,
  maxObjects: count,
  maxQueryItems: Type.Literal(200),
  maxPageBytes: count,
  maxOutputBytes: count,
  maxTriangles: count,
  maxResourceBytes: count,
  maxTotalResourceBytes: count,
  maxRetainedJobs: count,
  maxActiveDocuments: Type.Literal(1),
  maxActiveJobs: Type.Literal(1),
  jobTimeoutMs: count,
  queryTimeoutMs: count,
});
const profile = object({ linearDeflectionM: number, angularDeflectionRad: number });
const capabilities = object({
  contractVersion: Type.Literal(2),
  artifactSchemaVersion: Type.Literal(1),
  serverInstanceId: text(),
  parser: object({ name: text(), version: text() }),
  importerVersion: text(),
  supportedFormats: Type.Array(text(), { maxItems: 10 }),
  features: object({
    hierarchy: Type.Boolean(),
    instances: Type.Boolean(),
    sourceColors: Type.Boolean(),
    exactFeatures: Type.Array(CadFeatureTypeSchema, { maxItems: 5 }),
    faceMapping: Type.Boolean(),
    cancellationGranularity: text(),
    qualityProfiles: object({ preview: profile, standard: profile, fine: profile }),
  }),
  limits: CadLimitsSchema,
});
export const cadInputs = {
  cad_get_capabilities: object({}),
  cad_import_step: object({
    path: text(4096),
    options: Type.Optional(
      object({
        sourceUnitOverride: Type.Optional(
          Type.Enum(["m", "mm", "cm", "in", "ft"], { type: "string" }),
        ),
      }),
    ),
  }),
  cad_decompose_object: object({ document: CadHandleSchema, objectId: text() }),
  cad_get_structure: object({
    document: CadHandleSchema,
    mode: Type.Enum(["children", "all"], { type: "string" }),
    parentObjectId: Type.Optional(text()),
    nameContains: Type.Optional(Type.String({ maxLength: 128 })),
    ...page,
  }),
  cad_get_properties: object({
    document: CadHandleSchema,
    objectIds: Type.Array(text(), {
      minItems: 1,
      maxItems: 50,
      description: "Distinct object IDs; request each object only once.",
    }),
    fields: CadPropertyFieldsSchema,
  }),
  cad_measure_distance: object({
    document: CadHandleSchema,
    first: object({ objectId: text(), placement: CadTransformSchema }),
    second: object({ objectId: text(), placement: CadTransformSchema }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  }),
  cad_list_geometry_features: object({
    document: CadHandleSchema,
    objectId: text(),
    topologyRef: Type.Optional(CadTopologySchema),
    types: Type.Array(CadFeatureTypeSchema, { minItems: 1, maxItems: 5 }),
    ...page,
  }),
  cad_build_display: object({
    document: CadHandleSchema,
    quality: CadQualitySchema,
  }),
  cad_get_job: object({ job: CadHandleSchema }),
  cad_wait_job: object({ job: CadHandleSchema }),
  cad_cancel_job: object({ job: CadHandleSchema }),
  cad_release_document: object({ document: CadHandleSchema }),
};
export type CadToolName = keyof typeof cadInputs;
export const cadDisplayDescriptions: Record<CadToolName, string> = {
  cad_get_capabilities: "查询支持的格式与解析能力。",
  cad_import_step: "导入项目中的 STEP 文件。",
  cad_decompose_object: "按独立实体或游离壳拆分对象，保持位置与原始几何。",
  cad_get_structure: "读取装配层级与对象位置。",
  cad_get_properties: "查询尺寸、拓扑、原始颜色、几何量与有效性。",
  cad_measure_distance: "按指定刚体位姿测量两个 CAD 对象的最短距离。",
  cad_list_geometry_features: "查询圆心、轴线等精确几何特征。",
  cad_build_display: "生成三维显示资源。",
  cad_get_job: "查询任务进度与结果。",
  cad_wait_job: "等待任务真实终态并报告进度。",
  cad_cancel_job: "取消正在执行的任务。",
  cad_release_document: "释放临时 CAD 文档。",
};
export type CadInput<K extends CadToolName> = Static<(typeof cadInputs)[K]>;
export const cadOutputs = {
  cad_get_capabilities: capabilities,
  cad_import_step: object({ job: CadHandleSchema }),
  cad_decompose_object: object({
    changed: Type.Boolean(),
    parentObjectId: text(),
    childObjectIds: Type.Array(text(), { maxItems: 50 }),
    childCount: count,
    objectCount: count,
  }),
  cad_get_structure: CadObjectPageSchema,
  cad_get_properties: object({ items: Type.Array(CadPropertySchema, { maxItems: 50 }) }),
  cad_measure_distance: CadDistanceSchema,
  cad_list_geometry_features: object({
    items: Type.Array(CadFeatureSchema, { maxItems: 200 }),
    nextCursor: Type.Optional(text(1000)),
    analysisComplete: Type.Boolean(),
    warnings,
  }),
  cad_build_display: object({ job: CadHandleSchema }),
  cad_get_job: CadJobSchema,
  cad_wait_job: CadJobSchema,
  cad_cancel_job: object({ job: CadHandleSchema, cancelRequested: Type.Boolean(), status }),
  cad_release_document: object({ released: Type.Literal(true) }),
} satisfies Record<CadToolName, TSchema>;
export type CadOutput<K extends CadToolName> = Static<(typeof cadOutputs)[K]>;
export const cadDescriptions: Record<CadToolName, string> = {
  cad_get_capabilities: "Read CAD parser capabilities and limits.",
  cad_import_step:
    "Import an absolute STEP path inside the allowed directory into a temporary CAD document. Return the exact path; do not omit or substitute the selected file.",
  cad_decompose_object:
    "Unpack existing assembly children, or split a shape into genuine independent solids/loose shells in place. Never cuts a fused solid or separates a solid’s internal shells. Does not generate or save display; inspect the returned children, then choose cad_build_display to generate display resources for the derived geometry.",
  cad_get_structure: "Read objects, instances and their original placements.",
  cad_get_properties:
    "Read original CAD bounds, topology, colors, optional B-Rep validity or numerical area/volume/centroid measures in object coordinates. Measures are geometric, not density, mass or inertia; no geometry healing is performed.",
  cad_measure_distance:
    "Compute read-only B-Rep minimum distance between two objects at explicitly supplied rigid placements in a common Z-up coordinate system. Returns meters and bounded closest-point pairs. Zero distance does not distinguish contact from penetration; this is not a collision certificate or constraint solver.",
  cad_list_geometry_features: "Query exact CAD features on an object or selected topology.",
  cad_build_display: "Generate GLB display resources and CAD face mappings.",
  cad_get_job: "Read a CAD task's actual state and result.",
  cad_wait_job:
    "Wait for an accepted CAD job to reach its actual terminal state, reporting progress.",
  cad_cancel_job: "Request cancellation of a CAD task.",
  cad_release_document:
    "Release a temporary CAD document. Completed display resources remain available until service close.",
};
export const cadEnvelope = (data: TSchema) =>
  Type.Union([
    object({ ok: Type.Literal(true), data }),
    object({ ok: Type.Literal(false), error }),
  ]);
export const CadManifestSchema = object({
  schemaVersion: Type.Literal(1),
  source: SourceVersionSchema,
  roots: Type.Array(text()),
  displayToScene: CadTransformSchema,
  coordinateSystem: object({
    unit: Type.Literal("m"),
    upAxis: Type.Literal("Z"),
    handedness: Type.Literal("right"),
    gltfConversion: Type.Literal("x,z,-y"),
  }),
  quality: CadQualitySchema,
  complete: Type.Boolean(),
  // Unique geometry faces; repeated instances do not multiply this count.
  omittedFaceCount: Type.Optional(count),
  resources: Type.Array(CadResourceSchema, { maxItems: 10 }),
  objects: Type.Array(
    object({
      objectId: text(),
      name: Type.String({ maxLength: 1000 }),
      kind: Type.Enum(["assembly", "shape"]),
      sourceKey: text(4096),
      parentObjectId: Type.Optional(text()),
      geometryId: Type.Optional(text()),
      geometryResourceUri: Type.Optional(text(8192)),
      display: Type.Optional(object({ faceCount: count, omittedFaceCount: count })),
      nodeKey: text(),
      localTransform: CadTransformSchema,
      appearance: Type.Optional(object({ objectColor: rgba })),
    }),
  ),
  diagnostics: Type.Array(
    object({
      objectId: text(),
      topologyRef: Type.Optional(CadTopologySchema),
      stage: text(),
      status: text(),
    }),
    { maxItems: 100 },
  ),
  warnings,
});
export type CadManifest = Static<typeof CadManifestSchema>;
export const CadFaceMapSchema = object({
  schemaVersion: Type.Literal(1),
  sourceHash: hash,
  importFingerprint: hash,
  omittedFaces: Type.Optional(
    Type.Array(object({ geometryId: text(), topologyRef: CadTopologySchema })),
  ),
  recoveries: Type.Optional(
    Type.Array(
      object({
        geometryId: text(),
        topologyRef: CadTopologySchema,
        method: Type.Enum(["normalized", "refined_boundary", "same_parameter"]),
        originalStatusFlags: Type.Integer({ minimum: 0 }),
        sourceAreaM2: Type.Number({ exclusiveMinimum: 0 }),
        meshAreaM2: Type.Number({ exclusiveMinimum: 0 }),
        toleranceIncreaseM: Type.Number({ minimum: 0 }),
      }),
      { maxItems: 128 },
    ),
  ),
  ranges: Type.Array(
    object({
      geometryId: text(),
      meshIndex: count,
      primitiveIndex: count,
      firstTriangle: count,
      triangleCount: Type.Integer({ minimum: 1 }),
      topologyRef: CadTopologySchema,
    }),
  ),
});
export type CadFaceMap = Static<typeof CadFaceMapSchema>;
export function validateCadInput<K extends CadToolName>(
  name: K,
  value: unknown,
): asserts value is CadInput<K> {
  if (!Value.Check(cadInputs[name], value)) throw new Error(`Invalid CAD input: ${name}`);
}
export type CadResponse<K extends CadToolName = CadToolName> =
  | { ok: true; data: CadOutput<K> }
  | { ok: false; error: Static<typeof error> };
export function validateCadOutput<K extends CadToolName>(
  name: K,
  value: unknown,
): asserts value is CadResponse<K> {
  if (!Value.Check(cadEnvelope(cadOutputs[name]), value))
    throw new Error(`Invalid CAD response: ${name}`);
}

// Successful display jobs can publish partial meshes with explicit omissions.
export const DisplayArtifactSchema = object({
  schemaVersion: Type.Literal(1),
  kind: Type.Literal("cad-display"),
  source: SourceVersionSchema,
  manifest: CadResourceSchema,
});
export type DisplayArtifact = Static<typeof DisplayArtifactSchema>;
export const cadTools = (Object.keys(cadInputs) as CadToolName[]).map((name) => ({
  name,
  description: cadDescriptions[name],
  inputSchema: { ...cadInputs[name], type: "object" as const },
  outputSchema: { ...cadEnvelope(cadOutputs[name]), type: "object" as const },
}));
