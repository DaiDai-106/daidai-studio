import { type Static, Type } from "typebox";

// Built-in workflow instructions follow their mode; executable tools remain independently switchable.
export const modeSkillIds: ReadonlySet<string> = new Set([
  "builtin-scene",
  "builtin-alignment-skill",
]);

const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 200 });
export const CapabilityScopeSchema = Type.Union([
  object({ kind: Type.Literal("global") }),
  object({ kind: Type.Literal("project"), projectId: id }),
]);
export type CapabilityScope = Static<typeof CapabilityScopeSchema>;
export const SkillConfigSchema = object({
  id,
  name: Type.String({ minLength: 1, maxLength: 100 }),
  description: Type.String({ minLength: 1, maxLength: 1000 }),
  body: Type.String({ minLength: 1, maxLength: 32000 }),
  enabled: Type.Boolean(),
  scope: CapabilityScopeSchema,
  modes: Type.Array(Type.Union([Type.Literal("general"), Type.Literal("scene")]), {
    minItems: 1,
    maxItems: 2,
    uniqueItems: true,
  }),
});
export type SkillConfig = Static<typeof SkillConfigSchema>;
const mcp = {
  id,
  name: Type.String({ minLength: 1, maxLength: 100 }),
  enabled: Type.Boolean(),
  scope: CapabilityScopeSchema,
  modes: SkillConfigSchema.properties.modes,
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 300000 }),
};
export const McpConfigSchema = Type.Union([
  object({
    ...mcp,
    transport: Type.Literal("stdio"),
    command: Type.String({ minLength: 1, maxLength: 4096 }),
    args: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 100 }),
  }),
  object({
    ...mcp,
    transport: Type.Literal("http"),
    url: Type.String({ minLength: 1, maxLength: 4096 }),
  }),
]);
export type McpConfig = Static<typeof McpConfigSchema>;
export const McpInspectionSchema = object({
  serverName: Type.String({ maxLength: 200 }),
  serverVersion: Type.String({ maxLength: 200 }),
  tools: Type.Array(
    object({ name: id, description: Type.Optional(Type.String({ maxLength: 2000 })) }),
    { maxItems: 500 },
  ),
});
export type McpInspection = Static<typeof McpInspectionSchema>;
export const BuiltinCatalogSchema = object({
  servers: Type.Array(
    object({
      id,
      name: Type.String({ minLength: 1, maxLength: 100 }),
      description: Type.String({ maxLength: 1000 }),
      modes: SkillConfigSchema.properties.modes,
      available: Type.Boolean(),
      tools: Type.Array(object({ name: id, description: Type.String({ maxLength: 1000 }) }), {
        maxItems: 1000,
      }),
    }),
    { maxItems: 100 },
  ),
  skills: Type.Array(
    object({
      id,
      name: Type.String({ minLength: 1, maxLength: 100 }),
      description: Type.String({ maxLength: 1000 }),
      modes: SkillConfigSchema.properties.modes,
      automatic: Type.Boolean(),
      body: Type.Union([Type.String({ maxLength: 64000 }), Type.Null()]),
    }),
    { maxItems: 100 },
  ),
});
export type BuiltinCatalog = Static<typeof BuiltinCatalogSchema>;
