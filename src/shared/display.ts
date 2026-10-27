import { type Static, Type } from "typebox";
import { PlacementSchema } from "../../resources/mcp/alignment/contract.ts";

const id = Type.String({ minLength: 1, maxLength: 200 });
export const ImportIdSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const ImportedModelRefSchema = Type.Object(
  {
    importId: ImportIdSchema,
    sourceId: id,
    sourceHash: ImportIdSchema,
  },
  { additionalProperties: false },
);
export type ImportedModelRef = Static<typeof ImportedModelRefSchema>;
export const DisplayResourceSchema = Type.Object(
  {
    id: ImportIdSchema,
    url: Type.String({ maxLength: 512 }),
    mediaType: Type.String({ maxLength: 100 }),
    byteLength: Type.Integer({ minimum: 0 }),
    sha256: ImportIdSchema,
  },
  { additionalProperties: false },
);
export type DisplayResource = Static<typeof DisplayResourceSchema>;
export const ImportedModelSchema = Type.Object(
  {
    ...ImportedModelRefSchema.properties,
    projectId: id,
    importFingerprint: ImportIdSchema,
    producerTaskId: id,
    producerEntryId: id,
    createdAt: Type.String({ maxLength: 100 }),
    manifest: DisplayResourceSchema,
    resources: Type.Array(DisplayResourceSchema, { maxItems: 10 }),
    warnings: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 100 }),
    placement: Type.Optional(PlacementSchema),
    sourceStatus: Type.Optional(Type.Enum(["current", "changed", "missing"])),
  },
  { additionalProperties: false },
);
export type ImportedModel = Static<typeof ImportedModelSchema>;

// Only opaque registered identities cross into the renderer, never a filesystem path.
export function displayResourceUrl(importId: string, resourceId: string) {
  return `dai-resource://${importId}/${resourceId}`;
}
