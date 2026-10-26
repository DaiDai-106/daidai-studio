import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type BuiltinCatalog,
  BuiltinCatalogSchema,
  type McpConfig,
  McpConfigSchema,
  type McpInspection,
  McpInspectionSchema,
  type SkillConfig,
  SkillConfigSchema,
} from "./capabilities.ts";
import type { Theme } from "./desktop.ts";
import { type ImportedModel, ImportedModelSchema, ImportIdSchema } from "./display.ts";
import { type StepSourceInfo, StepSourceSchema } from "./projects.ts";

const text = (maxLength = 200) => Type.String({ maxLength });
const id = Type.String({ minLength: 1, maxLength: 200 });
const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const ModelSchema = object({
  id,
  name: text(),
  context: Type.Integer({ minimum: 1024, maximum: 10_000_000 }),
  output: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
  reasoning: text(),
});
export type ModelChoice = Static<typeof ModelSchema>;
export const ProviderSchema = object({
  id,
  name: Type.String({ minLength: 1, maxLength: 100 }),
  providerType: id,
  authMethod: Type.Union([
    Type.Literal("api_key"),
    Type.Literal("oauth"),
    Type.Literal("none"),
    Type.Literal("environment"),
  ]),
  endpoint: text(2000),
  enabled: Type.Boolean(),
  models: Type.Array(ModelSchema, { maxItems: 100 }),
  persistCredentials: Type.Boolean(),
});
export type ProviderConfig = Static<typeof ProviderSchema>;
export type ProviderInfo = ProviderConfig & { configured: boolean; temporary: boolean };
export type ProviderTypeInfo = {
  id: string;
  name: string;
  endpoint: string;
  methods: { id: ProviderConfig["authMethod"]; name: string }[];
};
export type ProjectInfo = {
  id: string;
  name: string;
  path: string;
  files: string[];
  available: boolean;
};
export type ConversationInfo = {
  id: string;
  projectId: string;
  title: string;
  mode: "general" | "scene";
  modelId: string;
  draft: string;
  archived: boolean;
  interrupted: boolean;
  source: StepSourceInfo | null;
};
const UsageSchema = object({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheWrite: Type.Number({ minimum: 0 }),
  totalTokens: Type.Number({ minimum: 0 }),
  estimatedCostUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
});
export type UsageInfo = Static<typeof UsageSchema>;
const ResponseSchema = object({
  model: text(500),
  provider: text(200),
  contextWindow: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  usage: UsageSchema,
});
export type ResponseInfo = Static<typeof ResponseSchema>;
const ToolProgressSchema = object({
  id,
  name: text(200),
  phase: text(200),
  displayName: Type.Optional(text(200)),
  serverName: Type.Optional(text(200)),
  status: Type.Union([Type.Literal("pending"), Type.Literal("running")]),
});
export type ToolProgressInfo = Static<typeof ToolProgressSchema>;
const ToolResultSchema = object({
  name: text(200),
  durationMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  displayName: Type.Optional(text(200)),
  serverName: Type.Optional(text(200)),
});
export type MessageInfo = {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  failed: boolean;
  response?: ResponseInfo;
  tool?: Static<typeof ToolResultSchema>;
};
export type SettingsInfo = {
  providers: ProviderInfo[];
  defaultModel: string;
  theme: Theme;
  disabledCapabilities: string[];
  skills: SkillConfig[];
  mcpServers: McpConfig[];
};
export type WorkspaceInfo = {
  settings: SettingsInfo;
  projects: ProjectInfo[];
  conversations: ConversationInfo[];
  nextCursor: string | null;
  dataRoot: string;
  secureStorage: boolean;
  busyConversationId: string | null;
  cadAvailable: boolean;
  builtins: BuiltinCatalog;
};
export type ConversationView = {
  conversationId: string;
  streamId: string;
  sequence: number;
  messages: MessageInfo[];
  partial: string;
  busy: boolean;
  error: string;
  usage: UsageInfo;
  latestResponse: ResponseInfo | null;
  respondingModel: string | null;
  activeTools: ToolProgressInfo[];
};
export type LoginPrompt = {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder: string;
  options: { id: string; label: string }[];
};
export type LoginInfo = {
  id: string;
  providerType: string;
  method: ProviderConfig["authMethod"];
  status: "waiting" | "success" | "cancelled" | "error";
  message: string;
  url: string;
  code: string;
  prompt: LoginPrompt | null;
};
export type ApplicationEvent =
  | { type: "workspace" }
  | { type: "conversationDeleted"; id: string }
  | { type: "conversation"; view: ConversationView }
  | { type: "login"; login: LoginInfo }
  | { type: "display.changed"; sourceId: string; importId: string };

export const commands = {
  "display.get": object({ id }),
  "mcp.save": object({ config: McpConfigSchema }),
  "mcp.remove": object({ id }),
  "mcp.inspect": object({ config: McpConfigSchema, projectId: id }),
  "mcp.cancelInspect": object({ id }),
  "skill.save": object({ config: SkillConfigSchema }),
  "skill.remove": object({ id }),
  "workspace.get": object({ cursor: Type.Optional(text(4000)) }),
  "provider.types": object({}),
  "provider.models": object({
    config: ProviderSchema,
    loginId: Type.Optional(id),
    discover: Type.Boolean(),
  }),
  "provider.save": object({ config: ProviderSchema, loginId: Type.Optional(id) }),
  "provider.remove": object({ id }),
  "settings.update": object({
    defaultModel: Type.Optional(text(500)),
    theme: Type.Optional(
      Type.Union([Type.Literal("light"), Type.Literal("dark"), Type.Literal("system")]),
    ),
  }),
  "capability.setEnabled": object({
    id: Type.Union([Type.Literal("builtin.cad"), Type.Literal("builtin-scene")]),
    enabled: Type.Boolean(),
  }),
  "auth.start": object({
    providerType: id,
    method: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]),
  }),
  "auth.answer": object({ id, promptId: id, value: text(32768) }),
  "auth.cancel": object({ id }),
  "auth.status": object({ id }),
  "auth.open": object({ id }),
  "project.open": object({ path: Type.String({ minLength: 1, maxLength: 4096 }) }),
  "project.refresh": object({ id }),
  "project.remove": object({ id }),
  "conversation.create": object({ projectId: id }),
  "conversation.delete": object({ id }),
  "conversation.selectStep": object({ id, relativePath: text(4096) }),
  "conversation.update": object({
    id,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    mode: Type.Optional(Type.Union([Type.Literal("general"), Type.Literal("scene")])),
    modelId: Type.Optional(text(500)),
    draft: Type.Optional(text(100000)),
    archived: Type.Optional(Type.Boolean()),
  }),
  "conversation.watch": object({ id }),
  "conversation.send": object({
    id,
    requestId: id,
    text: Type.String({ minLength: 1, maxLength: 100000 }),
  }),
  "conversation.stop": object({ id }),
} as const;
export type Method = keyof typeof commands;
export type Arguments<K extends Method> = Static<(typeof commands)[K]>;
export type Results = {
  "display.get": ImportedModel | null;
  "mcp.save": McpConfig;
  "mcp.remove": null;
  "mcp.inspect": McpInspection;
  "mcp.cancelInspect": null;
  "skill.save": SkillConfig;
  "skill.remove": null;
  "workspace.get": WorkspaceInfo;
  "provider.types": ProviderTypeInfo[];
  "provider.models": ModelChoice[];
  "provider.save": ProviderInfo;
  "provider.remove": null;
  "settings.update": SettingsInfo;
  "capability.setEnabled": SettingsInfo;
  "auth.start": LoginInfo;
  "auth.answer": LoginInfo;
  "auth.cancel": null;
  "auth.status": LoginInfo;
  "auth.open": null;
  "project.open": ProjectInfo;
  "project.refresh": ProjectInfo;
  "project.remove": null;
  "conversation.create": ConversationInfo;
  "conversation.delete": null;
  "conversation.selectStep": ConversationInfo;
  "conversation.update": ConversationInfo;
  "conversation.watch": ConversationView;
  "conversation.send": { submissionId: string };
  "conversation.stop": null;
};
export function validateRequest(method: unknown, args: unknown): asserts method is Method {
  if (
    typeof method !== "string" ||
    !Object.hasOwn(commands, method) ||
    !Value.Check(commands[method as Method], args)
  )
    throw new Error("请求参数无效。");
}

const ProviderInfoSchema = object({
  ...ProviderSchema.properties,
  configured: Type.Boolean(),
  temporary: Type.Boolean(),
});
const ProjectInfoSchema = object({
  id,
  name: text(4096),
  path: text(4096),
  files: Type.Array(text(4096), { maxItems: 200 }),
  available: Type.Boolean(),
});
const ConversationInfoSchema = object({
  id,
  projectId: id,
  title: text(),
  mode: Type.Union([Type.Literal("general"), Type.Literal("scene")]),
  modelId: text(500),
  draft: text(100000),
  archived: Type.Boolean(),
  interrupted: Type.Boolean(),
  source: Type.Union([StepSourceSchema, Type.Null()]),
});
const SettingsInfoSchema = object({
  providers: Type.Array(ProviderInfoSchema, { maxItems: 100 }),
  defaultModel: text(500),
  theme: Type.Union([Type.Literal("light"), Type.Literal("dark"), Type.Literal("system")]),
  disabledCapabilities: Type.Array(id, { maxItems: 100 }),
  skills: Type.Array(SkillConfigSchema, { maxItems: 100 }),
  mcpServers: Type.Array(McpConfigSchema, { maxItems: 100 }),
});
const ConversationViewSchema = object({
  conversationId: id,
  streamId: id,
  sequence: Type.Integer({ minimum: 0 }),
  messages: Type.Array(
    object({
      id,
      role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool")]),
      text: text(4_000_000),
      failed: Type.Boolean(),
      response: Type.Optional(ResponseSchema),
      tool: Type.Optional(ToolResultSchema),
    }),
  ),
  partial: text(4_000_000),
  busy: Type.Boolean(),
  error: text(10000),
  usage: UsageSchema,
  latestResponse: Type.Union([ResponseSchema, Type.Null()]),
  respondingModel: Type.Union([text(500), Type.Null()]),
  activeTools: Type.Array(ToolProgressSchema, { maxItems: 100 }),
});
const LoginInfoSchema = object({
  id,
  providerType: id,
  method: ProviderSchema.properties.authMethod,
  status: Type.Union([
    Type.Literal("waiting"),
    Type.Literal("success"),
    Type.Literal("cancelled"),
    Type.Literal("error"),
  ]),
  message: text(32768),
  url: text(16000),
  code: text(1000),
  prompt: Type.Union([
    Type.Null(),
    object({
      id,
      type: Type.Union([
        Type.Literal("text"),
        Type.Literal("secret"),
        Type.Literal("select"),
        Type.Literal("manual_code"),
      ]),
      message: text(32768),
      placeholder: text(32768),
      options: Type.Array(object({ id, label: text(2000) })),
    }),
  ]),
});
export const resultSchemas = {
  "display.get": Type.Union([ImportedModelSchema, Type.Null()]),
  "mcp.save": McpConfigSchema,
  "mcp.remove": Type.Null(),
  "mcp.inspect": McpInspectionSchema,
  "mcp.cancelInspect": Type.Null(),
  "skill.save": SkillConfigSchema,
  "skill.remove": Type.Null(),
  "workspace.get": object({
    settings: SettingsInfoSchema,
    projects: Type.Array(ProjectInfoSchema, { maxItems: 100 }),
    conversations: Type.Array(ConversationInfoSchema, { maxItems: 100 }),
    nextCursor: Type.Union([text(4000), Type.Null()]),
    dataRoot: text(4096),
    secureStorage: Type.Boolean(),
    busyConversationId: Type.Union([id, Type.Null()]),
    cadAvailable: Type.Boolean(),
    builtins: BuiltinCatalogSchema,
  }),
  "provider.types": Type.Array(
    object({
      id,
      name: text(1000),
      endpoint: text(2000),
      methods: Type.Array(object({ id: ProviderSchema.properties.authMethod, name: text(1000) })),
    }),
  ),
  "provider.models": Type.Array(ModelSchema, { maxItems: 1000 }),
  "provider.save": ProviderInfoSchema,
  "provider.remove": Type.Null(),
  "settings.update": SettingsInfoSchema,
  "capability.setEnabled": SettingsInfoSchema,
  "auth.start": LoginInfoSchema,
  "auth.answer": LoginInfoSchema,
  "auth.status": LoginInfoSchema,
  "auth.cancel": Type.Null(),
  "auth.open": Type.Null(),
  "project.open": ProjectInfoSchema,
  "project.refresh": ProjectInfoSchema,
  "project.remove": Type.Null(),
  "conversation.create": ConversationInfoSchema,
  "conversation.delete": Type.Null(),
  "conversation.selectStep": ConversationInfoSchema,
  "conversation.update": ConversationInfoSchema,
  "conversation.watch": ConversationViewSchema,
  "conversation.send": object({ submissionId: id }),
  "conversation.stop": Type.Null(),
} satisfies Record<Method, import("typebox").TSchema>;
export function validateResult<K extends Method>(
  method: K,
  value: unknown,
): asserts value is Results[K] {
  if (!Value.Check(resultSchemas[method], value))
    throw new Error(`后端响应与应用协议不兼容（${method}）。`);
}
const EventSchema = Type.Union([
  object({ type: Type.Literal("display.changed"), sourceId: id, importId: ImportIdSchema }),
  object({ type: Type.Literal("workspace") }),
  object({ type: Type.Literal("conversationDeleted"), id }),
  object({ type: Type.Literal("conversation"), view: ConversationViewSchema }),
  object({ type: Type.Literal("login"), login: LoginInfoSchema }),
]);
export function validEvent(value: unknown): value is ApplicationEvent {
  return Value.Check(EventSchema, value);
}
