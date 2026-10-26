import type { McpClient } from "@earendil-works/pi-mcp";
import { type Static, Type } from "typebox";
import {
  DisplayResourceSchema,
  type ImportedModel,
  ImportedModelSchema,
} from "../../shared/display.ts";

export interface ResourceScope {
  readonly client: McpClient;
  /** Private directory created by the host for this local stdio connection. */
  readonly root: string;
}
export const PreparedModelSchema = Type.Object(
  {
    ...ImportedModelSchema.properties,
    producerTaskId: Type.Optional(ImportedModelSchema.properties.producerTaskId),
    producerEntryId: Type.Optional(ImportedModelSchema.properties.producerEntryId),
  },
  { additionalProperties: false },
);
export type PreparedModel = Static<typeof PreparedModelSchema>;
export type StoredResource = Static<typeof DisplayResourceSchema> & { file: string };
export type ImportedModelRecord = {
  model: ImportedModel;
  files: StoredResource[];
};
export type CurrentDisplayRecord = {
  importId: string;
  entryId: number;
};
export const PreparedDisplaySchema = Type.Object(
  {
    model: PreparedModelSchema,
    files: Type.Array(
      Type.Object(
        {
          ...DisplayResourceSchema.properties,
          file: Type.String({ pattern: "^(manifest\\.json|resources/[0-9a-f]{64})$" }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 11 },
    ),
  },
  { additionalProperties: false },
);
export type PreparedDisplay = Static<typeof PreparedDisplaySchema>;
