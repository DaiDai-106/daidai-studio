import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  CatalogTaskSchema,
  catalogCommands,
  catalogResults,
  PluginModuleSchema,
  PluginScopeSchema,
} from "./catalog.ts";
import {
  maxSceneAssetBytes,
  SceneAssetSchema,
  SceneOperationSchema,
  SceneRevisionSchema,
  SceneSnapshotSchema,
  StepAttachmentSchema,
} from "./scene.ts";
import { id, object } from "./schema.ts";

const text = (maxLength = 200) => Type.String({ maxLength });
const ProjectModeSchema = PluginModuleSchema;

// Pi 1.5 的 schema 使用 pi-schema；应用 IPC 仍使用 TypeBox 校验。
const ModelThinkingLevelSchema = Type.Enum(MODEL_THINKING_LEVELS);
const ImportIdSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
export type ThinkingLevel = Static<typeof ModelThinkingLevelSchema>;
const AccessModeSchema = Type.Union([Type.Literal("ask"), Type.Literal("full")]);
export type AccessMode = Static<typeof AccessModeSchema>;
const DeliveryModeSchema = Type.Enum(["steer", "followUp"]);
export type DeliveryMode = Static<typeof DeliveryModeSchema>;

const ModelSchema = object({
  id,
  name: text(),
  context: Type.Integer({ minimum: 1024, maximum: 10_000_000 }),
  output: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
  reasoning: text(),
  thinkingLevels: Type.Optional(Type.Array(ModelThinkingLevelSchema, { maxItems: 7 })),
  supportsImages: Type.Optional(Type.Boolean()),
  fast: Type.Optional(Type.Boolean()),
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

const ManagedSkillSchema = object({
  id: ImportIdSchema,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: text(4096),
  source: Type.Enum(["user", "package"]),
  editable: Type.Boolean(),
  ownerSource: Type.Optional(text(4096)),
  ownerScope: Type.Optional(PluginScopeSchema),
});
export type ManagedSkill = Static<typeof ManagedSkillSchema>;

const ExtensionUiRequestSchema = object({
  requestId: id,
  conversationId: id,
  kind: Type.Union([Type.Literal("confirm"), Type.Literal("select"), Type.Literal("input")]),
  title: text(1000),
  message: Type.Optional(text(8000)),
  options: Type.Optional(Type.Array(text(2000), { maxItems: 100 })),
  placeholder: Type.Optional(text(1000)),
});
export type ExtensionUiRequest = Static<typeof ExtensionUiRequestSchema>;

const ProviderSchema = object({
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
export type ApplicationEvent = Static<typeof EventSchema>;
// 请求名和参数由前端、桌面进程与后端共同使用。
const commands = {
  ...catalogCommands,
  "workspace.get": object({ cursor: Type.Optional(text(4000)) }),
  "usage.dashboard": object({}),
  "provider.types": object({}),
  "provider.models": object({
    config: ProviderSchema,
    loginId: Type.Optional(id),
    discover: Type.Boolean(),
  }),
  "provider.save": object({ config: ProviderSchema, loginId: Type.Optional(id) }),
  "provider.remove": object({ id }),
  "settings.update": object({
    desktopTheme: Type.Optional(text(300)),
    expectedDesktopTheme: Type.Optional(text(300)),
    showThinking: Type.Optional(Type.Boolean()),
    defaultModel: Type.Optional(text(500)),
    theme: Type.Optional(
      Type.Union([Type.Literal("light"), Type.Literal("dark"), Type.Literal("system")]),
    ),
  }),
  "auth.start": object({
    providerType: id,
    method: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]),
  }),
  "auth.answer": object({ id, promptId: id, value: text(32768) }),
  "auth.cancel": object({ id }),
  "auth.status": object({ id }),
  "auth.open": object({ id }),
  "project.create": object({
    name: Type.String({ minLength: 1, maxLength: 200 }),
    mode: ProjectModeSchema,
    path: Type.String({ minLength: 1, maxLength: 4096 }),
  }),
  "project.refresh": object({ id }),
  "project.remove": object({ id }),
  "project.hidden": object({}),
  "project.restore": object({ id }),
  "coding.list": object({
    projectId: id,
    path: text(4096),
    offset: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    snapshot: Type.Optional(text(64)),
  }),
  "coding.read": object({ projectId: id, path: text(4096) }),
  "coding.search": object({ projectId: id, query: Type.String({ maxLength: 200 }) }),
  "coding.changes": object({ projectId: id }),
  "coding.diff": object({
    projectId: id,
    path: text(4096),
    kind: Type.Union([Type.Literal("staged"), Type.Literal("unstaged"), Type.Literal("untracked")]),
  }),
  "scene.get": object({ projectId: id }),
  "scene.apply": object({
    projectId: id,
    expectedRevision: SceneRevisionSchema,
    operation: SceneOperationSchema,
  }),
  "scene.import": object({
    projectId: id,
    expectedRevision: SceneRevisionSchema,
    path: text(4096),
  }),
  "scene.importStep": object({
    projectId: id,
    expectedRevision: SceneRevisionSchema,
    path: text(4096),
    sourceOnly: Type.Optional(Type.Boolean()),
  }),
  "scene.cancelStep": object({ projectId: id }),
  "scene.export": object({
    projectId: id,
    directory: text(4096),
    expectedRevision: SceneRevisionSchema,
  }),
  "scene.asset": object({ projectId: id, asset: SceneAssetSchema }),
  "extension.ui.respond": object({
    requestId: id,
    cancelled: Type.Boolean(),
    value: Type.Optional(text(100000)),
  }),
  "skill.library.list": object({
    moduleId: Type.Optional(PluginModuleSchema),
    userOnly: Type.Optional(Type.Boolean()),
  }),
  "skill.library.read": object({ id: ImportIdSchema, moduleId: Type.Optional(PluginModuleSchema) }),
  "skill.library.create": object({
    name: Type.String({ minLength: 1, maxLength: 64 }),
    text: Type.String({ maxLength: 1_000_000 }),
  }),
  "skill.library.save": object({
    name: Type.String({ minLength: 1, maxLength: 64 }),
    text: Type.String({ maxLength: 1_000_000 }),
  }),
  "skill.library.import": object({ path: Type.String({ minLength: 1, maxLength: 4096 }) }),
  "conversation.create": object({ projectId: id }),
  "conversation.fork": object({ id }),
  "conversation.delete": object({ id }),
  "conversation.update": object({
    id,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    modelId: Type.Optional(text(500)),
    thinkingLevel: Type.Optional(ModelThinkingLevelSchema),
    accessMode: Type.Optional(AccessModeSchema),
    draft: Type.Optional(text(100000)),
    archived: Type.Optional(Type.Boolean()),
  }),
  "conversation.watch": object({ id }),
  "conversation.history": object({ id, turnId: id, before: Type.Optional(Type.Boolean()) }),
  "conversation.trace": object({ id }),
  "conversation.traceDetail": object({ id, entryId: id }),
  "conversation.send": object({
    id,
    requestId: id,
    delivery: Type.Optional(DeliveryModeSchema),
    text: Type.String({ maxLength: 100000 }),
    images: Type.Optional(Type.Array(ChatImageSchema, { maxItems: 3 })),
    stepPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  }),
  "conversation.stop": object({ id }),
  "conversation.cancelQueued": object({ id, messageId: id }),
  "conversation.promoteQueued": object({ id, messageId: id }),
  "conversation.resumeQueue": object({ id }),
  "shell.respond": object({ id, approved: Type.Boolean() }),
} as const;
export type Method = keyof typeof commands;
export type Arguments<K extends Method> = Static<(typeof commands)[K]>;
export type Results = { [K in Method]: Static<(typeof resultSchemas)[K]> };
// TypeScript 类型不会在运行时保留，跨进程请求仍需校验实际数据。
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
  unavailableModels: Type.Optional(Type.Array(id, { maxItems: 100 })),
});

const ProjectInfoSchema = object({
  id,
  name: text(4096),
  mode: ProjectModeSchema,
  path: text(4096),
  available: Type.Union([Type.Boolean(), Type.Null()]),
});

const ConversationInfoSchema = object({
  id,
  createdAt: Type.Integer({ minimum: 0 }),
  projectId: id,
  title: text(),
  mode: ProjectModeSchema,
  modelId: text(500),
  thinkingLevel: Type.Optional(ModelThinkingLevelSchema),
  accessMode: Type.Optional(AccessModeSchema),
  draft: text(100000),
  archived: Type.Boolean(),
  interrupted: Type.Boolean(),
});

const SettingsInfoSchema = object({
  desktopTheme: Type.Optional(text(300)),
  providers: Type.Array(ProviderInfoSchema, { maxItems: 100 }),
  defaultModel: text(500),
  theme: Type.Union([Type.Literal("light"), Type.Literal("dark"), Type.Literal("system")]),
  showThinking: Type.Optional(Type.Boolean()),
});

const MessageInfoSchema = object({
  id,
  eventLabel: Type.Optional(text(200)),
  role: Type.Union([
    Type.Literal("user"),
    Type.Literal("assistant"),
    Type.Literal("tool"),
    Type.Literal("event"),
  ]),
  text: text(4_000_000),
  images: Type.Optional(Type.Array(ChatImageSchema, { maxItems: 3 })),
  stepAttachment: Type.Optional(StepAttachmentSchema),
  failed: Type.Boolean(),
  response: Type.Optional(ResponseSchema),
  blocks: Type.Optional(Type.Array(MessageBlockSchema)),
  timestamp: Type.Optional(Type.Number()),
  durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  hasToolCalls: Type.Optional(Type.Boolean()),
  outcome: Type.Optional(OutcomeSchema),
  tool: Type.Optional(ToolResultSchema),
});

// 轨迹只投影原生历史；列表使用摘要，系统提示和工具定义在展开时按需读取。
const TraceRecordSchema = object({
  id,
  role: Type.Enum(["system", "user", "assistant", "tool", "event"]),
  turn: Type.Integer({ minimum: 0 }),
  label: text(200),
  preview: text(500),
  timestamp: Type.Number(),
  failed: Type.Boolean(),
});
const TraceCallSchema = object({
  callId: text(1000),
  ...Type.Pick(ToolResultSchema, ["name", "args", "argsTruncated"]).properties,
});
const TraceDetailSchema = object({
  text: text(4_000_000),
  calls: Type.Array(TraceCallSchema),
  tool: Type.Optional(ToolResultSchema),
  context: Type.Optional(
    object({
      recorded: Type.Boolean(),
      injections: Type.Array(object({ id, name: text(1000), text: text(4_000_000) })),
      content: text(4_000_000),
      sections: Type.Array(object({ name: text(1000), text: text(4_000_000) })),
      tools: Type.Array(
        object({
          name: text(500),
          description: text(4_000_000),
          parameters: text(100000),
          truncated: Type.Boolean(),
        }),
      ),
    }),
  ),
  truncated: Type.Boolean(),
});
export type TraceRecord = Static<typeof TraceRecordSchema>;
export type TraceDetail = Static<typeof TraceDetailSchema>;

const ConversationHistorySchema = object({
  start: Type.Integer({ minimum: 0 }),
  markers: Type.Array(object({ id, label: text(80) })),
});
const ConversationHistoryPageSchema = object({
  start: ConversationHistorySchema.properties.start,
  messages: Type.Array(MessageInfoSchema),
  nextTurnId: Type.Union([id, Type.Null()]),
  historyKey: text(400),
});
export type ConversationHistoryPage = Static<typeof ConversationHistoryPageSchema>;

const ConversationViewSchema = object({
  conversationId: id,
  streamId: id,
  sequence: Type.Integer({ minimum: 0 }),
  messages: Type.Array(MessageInfoSchema),
  history: ConversationHistorySchema,
  historyKey: Type.Optional(text(400)),
  partial: text(4_000_000),
  partialBlocks: Type.Optional(Type.Array(MessageBlockSchema)),
  partialHasToolCalls: Type.Optional(Type.Boolean()),
  activity: Type.Optional(
    Type.Enum(["waiting", "responding", "thinking", "tools", "retrying", "compacting"], {
      type: "string",
    }),
  ),
  queuedMessages: Type.Optional(
    Type.Array(
      object({
        id,
        text: text(1000),
        delivery: DeliveryModeSchema,
        imageCount: Type.Integer({ minimum: 0, maximum: 3 }),
        stepAttachment: Type.Optional(StepAttachmentSchema),
        delivering: Type.Boolean(),
        paused: Type.Boolean(),
      }),
      { maxItems: 20 },
    ),
  ),
  busy: Type.Boolean(),
  error: text(10000),
  usage: UsageSchema,
  branchUsage: Type.Optional(UsageSchema),
  latestResponse: Type.Union([ResponseSchema, Type.Null()]),
  respondingModel: Type.Union([text(500), Type.Null()]),
  activeTools: Type.Array(ToolProgressSchema, { maxItems: 100 }),
});

const ConversationProgressSchema = Type.Omit(ConversationViewSchema, ["messages", "history"]);
export type ConversationProgress = Static<typeof ConversationProgressSchema>;

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
// 返回值也按请求名校验，防止不符合契约的数据传到界面。
const resultSchemas = {
  ...catalogResults,
  "workspace.get": object({
    settings: SettingsInfoSchema,
    projects: Type.Array(ProjectInfoSchema, { maxItems: 100 }),
    conversations: Type.Array(ConversationInfoSchema, { maxItems: 100 }),
    nextCursor: Type.Union([text(4000), Type.Null()]),
    dataRoot: text(4096),
    busyConversationIds: Type.Array(id),
    shellApproval: Type.Optional(Type.Union([ShellApprovalSchema, Type.Null()])),
    extensionUiRequests: Type.Optional(Type.Array(ExtensionUiRequestSchema, { maxItems: 100 })),
  }),
  "usage.dashboard": object({
    events: Type.Array(
      object({
        id: text(100),
        timestamp: text(100),
        provider: text(200),
        model: text(500),
        ...UsageSchema.properties,
      }),
    ),
    incomplete: Type.Number({ minimum: 0 }),
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
  "auth.start": LoginInfoSchema,
  "auth.answer": LoginInfoSchema,
  "auth.status": LoginInfoSchema,
  "auth.cancel": Type.Null(),
  "auth.open": Type.Null(),
  "project.create": ProjectInfoSchema,
  "project.refresh": ProjectInfoSchema,
  "project.remove": Type.Null(),
  "project.hidden": Type.Array(ProjectInfoSchema),
  "project.restore": ProjectInfoSchema,
  "coding.list": object({
    snapshot: text(64),
    entries: Type.Array(object({ name: text(4096), directory: Type.Boolean() }), { maxItems: 200 }),
    nextOffset: Type.Union([Type.Integer({ minimum: 0, maximum: 1_000_000 }), Type.Null()]),
  }),
  "coding.read": object({ content: text(2_097_152), version: text(64) }),
  "coding.search": object({
    paths: Type.Array(text(4096), { maxItems: 100 }),
    truncated: Type.Boolean(),
  }),
  "coding.changes": object({
    entries: Type.Array(
      object({
        path: text(4096),
        staged: Type.Boolean(),
        unstaged: Type.Boolean(),
        untracked: Type.Boolean(),
      }),
      { maxItems: 200 },
    ),
    truncated: Type.Boolean(),
  }),
  "coding.diff": object({ patch: text(4_194_304), untracked: Type.Boolean() }),
  "scene.get": SceneSnapshotSchema,
  "scene.apply": SceneSnapshotSchema,
  "scene.import": SceneSnapshotSchema,
  "scene.importStep": SceneSnapshotSchema,
  "scene.cancelStep": Type.Null(),
  "scene.export": object({ path: text(4096) }),
  "scene.asset": Type.String({ maxLength: 4 * Math.ceil(maxSceneAssetBytes / 3) }),
  "extension.ui.respond": Type.Null(),
  "skill.library.list": Type.Array(ManagedSkillSchema),
  "skill.library.read": Type.String({ maxLength: 1_000_000 }),
  "skill.library.create": ManagedSkillSchema,
  "skill.library.save": ManagedSkillSchema,
  "skill.library.import": ManagedSkillSchema,
  "conversation.create": ConversationInfoSchema,
  "conversation.fork": ConversationInfoSchema,
  "conversation.delete": Type.Null(),
  "conversation.update": ConversationInfoSchema,
  "conversation.watch": ConversationViewSchema,
  "conversation.history": ConversationHistoryPageSchema,
  "conversation.trace": Type.Array(TraceRecordSchema),
  "conversation.traceDetail": TraceDetailSchema,
  "conversation.send": object({ submissionId: id }),
  "conversation.stop": Type.Null(),
  "conversation.cancelQueued": Type.Null(),
  "conversation.promoteQueued": Type.Null(),
  "conversation.resumeQueue": Type.Null(),
  "shell.respond": Type.Null(),
} satisfies Record<Method, import("typebox").TSchema>;

export function validateResult<K extends Method>(
  method: K,
  value: unknown,
): asserts value is Results[K] {
  if (!Value.Check(resultSchemas[method], value))
    throw new Error(`后端响应与应用协议不兼容（${method}）。`);
}

const EventSchema = Type.Union([
  object({ type: Type.Literal("catalog.task"), task: CatalogTaskSchema }),
  object({
    type: Type.Literal("extension.ui.notification"),
    conversationId: id,
    message: text(4000),
    level: Type.Enum(["info", "warning", "error"]),
  }),
  object({ type: Type.Literal("extension.ui.request"), request: ExtensionUiRequestSchema }),
  object({ type: Type.Literal("extension.ui.dismissed"), requestId: id, conversationId: id }),
  object({
    type: Type.Literal("scene.document"),
    projectId: id,
    snapshot: SceneSnapshotSchema,
    replaced: Type.Optional(Type.Literal(true)),
  }),
  object({ type: Type.Literal("workspace") }),
  object({ type: Type.Literal("conversationDeleted"), id }),
  object({ type: Type.Literal("conversation"), view: ConversationViewSchema }),
  object({ type: Type.Literal("conversation.progress"), view: ConversationProgressSchema }),
  object({ type: Type.Literal("login"), login: LoginInfoSchema }),
  object({
    type: Type.Literal("shell.approval"),
    approval: Type.Union([ShellApprovalSchema, Type.Null()]),
  }),
]);

export function validEvent(value: unknown): value is ApplicationEvent {
  return Value.Check(EventSchema, value);
}
