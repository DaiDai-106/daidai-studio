import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { CaptureViewSchema, ViewportCaptureSchema } from "../../resources/mcp/viewport/contract.ts";

export type { CaptureView, ViewportCapture } from "../../resources/mcp/viewport/contract.ts";

import {
  BuiltinCatalogSchema,
  McpConfigSchema,
  McpInspectionSchema,
  SkillConfigSchema,
  SkillImageSchema,
} from "./capabilities.ts";
import { ImportedModelSchema, ImportIdSchema } from "./display.ts";
import { StepSourceSchema } from "./projects.ts";

const text = (maxLength = 200) => Type.String({ maxLength });
const id = Type.String({ minLength: 1, maxLength: 200 });
const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export type ThinkingLevel = Static<typeof ModelThinkingLevelSchema>;
export const ModelSchema = object({
  id,
  name: text(),
  context: Type.Integer({ minimum: 1024, maximum: 10_000_000 }),
  output: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
  reasoning: text(),
  thinkingLevels: Type.Optional(Type.Array(ModelThinkingLevelSchema, { maxItems: 7 })),
  supportsImages: Type.Optional(Type.Boolean()),
});
export type ModelChoice = Static<typeof ModelSchema>;
export const ChatImageSchema = object({
  mimeType: Type.Union([
    Type.Literal("image/png"),
    Type.Literal("image/jpeg"),
    Type.Literal("image/webp"),
  ]),
  data: Type.String({ minLength: 1, maxLength: 7_000_000 }),
});
export type ChatImage = Static<typeof ChatImageSchema>;
export const SceneReferenceSchema = object({
  importId: ImportIdSchema,
  objectId: id,
  revision: Type.Integer({ minimum: 0 }),
});
export type SceneReference = Static<typeof SceneReferenceSchema>;
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
export type ProviderInfo = Static<typeof ProviderInfoSchema>;
export type ProviderTypeInfo = Static<(typeof resultSchemas)["provider.types"]>[number];
export type ProjectInfo = Static<typeof ProjectInfoSchema>;
export type ConversationInfo = Static<typeof ConversationInfoSchema>;
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
const ToolArgumentsSchema = Type.Record(Type.String(), Type.Unknown());
const MessageBlockSchema = object({
  kind: Type.Enum(["text", "thinking"], { type: "string" }),
  text: text(4_000_000),
  truncated: Type.Optional(Type.Boolean()),
});
export type MessageBlock = Static<typeof MessageBlockSchema>;
const OutcomeSchema = Type.Enum(["completed", "failed", "stopped"], { type: "string" });
const toolPresentationFields = {
  callKey: Type.Optional(text(1200)),
  args: Type.Optional(ToolArgumentsSchema),
  argsTruncated: Type.Optional(Type.Boolean()),
  output: Type.Optional(text(8000)),
  outputTruncated: Type.Optional(Type.Boolean()),
};
const ToolProgressSchema = object({
  id,
  ...toolPresentationFields,
  name: text(200),
  phase: text(200),
  displayName: Type.Optional(text(200)),
  serverName: Type.Optional(text(200)),
  status: Type.Union([Type.Literal("pending"), Type.Literal("running")]),
});
export type ToolProgressInfo = Static<typeof ToolProgressSchema>;
const ToolResultSchema = object({
  ...toolPresentationFields,
  callId: Type.Optional(text(1000)),
  name: text(200),
  durationMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  displayName: Type.Optional(text(200)),
  serverName: Type.Optional(text(200)),
});
export type MessageInfo = Static<typeof MessageInfoSchema>;
export type SettingsInfo = Static<typeof SettingsInfoSchema>;
export type WorkspaceInfo = Static<(typeof resultSchemas)["workspace.get"]>;
const ShellApprovalSchema = object({
  id,
  conversationId: id,
  command: text(16000),
  cwd: text(4096),
  shell: text(40),
});
export type ShellApproval = Static<typeof ShellApprovalSchema>;
export type ConversationView = Static<typeof ConversationViewSchema>;
export type LoginInfo = Static<typeof LoginInfoSchema>;
export type LoginPrompt = NonNullable<LoginInfo["prompt"]>;
export type ApplicationEvent = Static<typeof EventSchema>;
export const commands = {
  "display.get": object({ id }),
  "mcp.save": object({ config: McpConfigSchema }),
  "mcp.remove": object({ id }),
  "mcp.inspect": object({ config: McpConfigSchema, projectId: id }),
  "mcp.cancelInspect": object({ id }),
  "skill.save": object({ config: SkillConfigSchema }),
  "skill.image.add": object({
    id,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    image: ChatImageSchema,
  }),
  "skill.image.read": object({ id, path: SkillImageSchema.properties.path }),
  "skill.image.remove": object({ id, path: SkillImageSchema.properties.path }),
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
    showThinking: Type.Optional(Type.Boolean()),
    defaultModel: Type.Optional(text(500)),
    theme: Type.Optional(
      Type.Union([Type.Literal("light"), Type.Literal("dark"), Type.Literal("system")]),
    ),
  }),
  "capability.setEnabled": object({
    id: Type.Union([
      Type.Literal("builtin.cad"),
      Type.Literal("builtin.alignment"),
      Type.Literal("builtin.viewport"),
      Type.Literal("builtin.scene-profiles"),
      Type.Literal("builtin-scene"),
      Type.Literal("builtin-alignment-skill"),
    ]),
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
    thinkingLevel: Type.Optional(ModelThinkingLevelSchema),
    draft: Type.Optional(text(100000)),
    archived: Type.Optional(Type.Boolean()),
  }),
  "conversation.watch": object({ id }),
  "conversation.send": object({
    id,
    requestId: id,
    text: Type.String({ maxLength: 100000 }),
    images: Type.Optional(Type.Array(ChatImageSchema, { maxItems: 3 })),
    sceneReference: Type.Optional(SceneReferenceSchema),
  }),
  "conversation.startScene": object({ id }),
  "conversation.stop": object({ id }),
  "shell.respond": object({ id, approved: Type.Boolean() }),
  "viewport.respond": object({ id, capture: Type.Union([ViewportCaptureSchema, Type.Null()]) }),
} as const;
export type Method = keyof typeof commands;
export type Arguments<K extends Method> = Static<(typeof commands)[K]>;
export type Results = { [K in Method]: Static<(typeof resultSchemas)[K]> };
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
  filesComplete: Type.Boolean(),
  available: Type.Boolean(),
});
const ConversationInfoSchema = object({
  id,
  projectId: id,
  title: text(),
  mode: Type.Union([Type.Literal("general"), Type.Literal("scene")]),
  modelId: text(500),
  thinkingLevel: Type.Optional(ModelThinkingLevelSchema),
  draft: text(100000),
  archived: Type.Boolean(),
  interrupted: Type.Boolean(),
  source: Type.Union([StepSourceSchema, Type.Null()]),
});
const SettingsInfoSchema = object({
  providers: Type.Array(ProviderInfoSchema, { maxItems: 100 }),
  defaultModel: text(500),
  theme: Type.Union([Type.Literal("light"), Type.Literal("dark"), Type.Literal("system")]),
  showThinking: Type.Optional(Type.Boolean()),
  disabledCapabilities: Type.Array(id, { maxItems: 100 }),
  skills: Type.Array(SkillConfigSchema, { maxItems: 100 }),
  mcpServers: Type.Array(McpConfigSchema, { maxItems: 100 }),
});
const MessageInfoSchema = object({
  id,
  role: Type.Union([
    Type.Literal("user"),
    Type.Literal("assistant"),
    Type.Literal("tool"),
    Type.Literal("event"),
  ]),
  text: text(4_000_000),
  images: Type.Optional(Type.Array(ChatImageSchema, { maxItems: 3 })),
  failed: Type.Boolean(),
  response: Type.Optional(ResponseSchema),
  blocks: Type.Optional(Type.Array(MessageBlockSchema)),
  timestamp: Type.Optional(Type.Number()),
  durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  hasToolCalls: Type.Optional(Type.Boolean()),
  outcome: Type.Optional(OutcomeSchema),
  tool: Type.Optional(ToolResultSchema),
});
const ConversationViewSchema = object({
  conversationId: id,
  streamId: id,
  sequence: Type.Integer({ minimum: 0 }),
  messages: Type.Array(MessageInfoSchema),
  partial: text(4_000_000),
  partialBlocks: Type.Optional(Type.Array(MessageBlockSchema)),
  partialHasToolCalls: Type.Optional(Type.Boolean()),
  activity: Type.Optional(
    Type.Enum(["waiting", "responding", "thinking", "tools", "retrying", "compacting"], {
      type: "string",
    }),
  ),
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
  "skill.image.add": SkillImageSchema,
  "skill.image.read": ChatImageSchema,
  "skill.image.remove": Type.Null(),
  "skill.remove": Type.Null(),
  "workspace.get": object({
    settings: SettingsInfoSchema,
    projects: Type.Array(ProjectInfoSchema, { maxItems: 100 }),
    conversations: Type.Array(ConversationInfoSchema, { maxItems: 100 }),
    nextCursor: Type.Union([text(4000), Type.Null()]),
    dataRoot: text(4096),
    secureStorage: Type.Boolean(),
    busyConversationId: Type.Union([id, Type.Null()]),
    shellApproval: Type.Optional(Type.Union([ShellApprovalSchema, Type.Null()])),
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
  "conversation.startScene": Type.Null(),
  "conversation.stop": Type.Null(),
  "shell.respond": Type.Null(),
  "viewport.respond": Type.Null(),
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
  object({
    type: Type.Literal("shell.approval"),
    approval: Type.Union([ShellApprovalSchema, Type.Null()]),
  }),
  object({
    type: Type.Literal("viewport.capture"),
    id,
    conversationId: id,
    importId: ImportIdSchema,
    revision: Type.Integer({ minimum: 0 }),
    view: CaptureViewSchema,
  }),
  object({ type: Type.Literal("viewport.capture.cancel"), id }),
]);
export function validEvent(value: unknown): value is ApplicationEvent {
  return Value.Check(EventSchema, value);
}
