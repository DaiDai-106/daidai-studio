import type {
  ApplicationEvent,
  Arguments,
  ConversationInfo,
  ConversationView,
  LoginInfo,
  ManagedSkill,
  ModelChoice,
  ProjectInfo,
  ProviderConfig,
  ProviderInfo,
  ProviderTypeInfo,
  Results,
  SettingsInfo,
  WorkspaceInfo,
} from "./application.ts";
import type { ConversationMode } from "./capabilities.ts";

export type CreateProjectInput = {
  name: string;
  mode: ConversationMode;
  directoryToken?: string;
};

// 渲染界面可通过 preload 调用的应用接口；具体执行交给桌面进程和后端。
export interface ApplicationBridge {
  catalogSources(): Promise<Results["catalog.sources"]>;
  searchCatalog(input: Arguments<"catalog.search">): Promise<Results["catalog.search"]>;
  catalogDetail(input: Arguments<"catalog.detail">): Promise<Results["catalog.detail"]>;
  configureCatalog(input: Arguments<"catalog.configure">): Promise<null>;
  installedPlugins(
    moduleId?: Arguments<"catalog.installed">["moduleId"],
  ): Promise<Results["catalog.installed"]>;
  catalogTasks(): Promise<Results["catalog.tasks"]>;
  installCatalog(input: Arguments<"catalog.install">): Promise<Results["catalog.install"]>;
  packageAction(
    input: Arguments<"catalog.packageAction">,
  ): Promise<Results["catalog.packageAction"]>;
  // 工作区、模型提供方和配置。
  getWorkspace(cursor?: string): Promise<WorkspaceInfo>;
  getProviderTypes(): Promise<ProviderTypeInfo[]>;
  getModels(
    config: ProviderConfig,
    loginId: string | undefined,
    discover: boolean,
  ): Promise<ModelChoice[]>;
  saveProvider(config: ProviderConfig, loginId?: string): Promise<ProviderInfo>;
  removeProvider(id: string): Promise<null>;
  updateSettings(change: Arguments<"settings.update">): Promise<SettingsInfo>;

  // 认证交互由后端维护状态，前端只提交当前步骤的回答。
  startLogin(providerType: string, method: "api_key" | "oauth"): Promise<LoginInfo>;
  answerLogin(id: string, promptId: string, value: string): Promise<LoginInfo>;
  cancelLogin(id: string): Promise<null>;
  getLogin(id: string): Promise<LoginInfo>;
  openLogin(id: string): Promise<null>;

  // 项目路径通过系统选择器获取，对话保存和发送使用对话 ID。
  chooseProjectDirectory(): Promise<{ token: string; path: string } | null>;
  createProject(input: CreateProjectInput): Promise<ProjectInfo | null>;
  refreshProject(id: string): Promise<ProjectInfo>;
  removeProject(id: string): Promise<null>;
  listHiddenProjects(): Promise<ProjectInfo[]>;
  restoreProject(id: string): Promise<ProjectInfo>;

  listCodingFiles(
    projectId: string,
    path: string,
    offset: number,
    snapshot?: string,
  ): Promise<Results["coding.list"]>;
  searchCodingFiles(projectId: string, query: string): Promise<Results["coding.search"]>;
  readCodingFile(projectId: string, path: string): Promise<Results["coding.read"]>;
  listCodingChanges(projectId: string): Promise<Results["coding.changes"]>;
  readCodingDiff(
    projectId: string,
    path: string,
    kind: "staged" | "unstaged" | "untracked",
  ): Promise<Results["coding.diff"]>;
  forkConversation(id: string): Promise<ConversationInfo>;
  respondExtensionUi(input: {
    requestId: string;
    cancelled: boolean;
    value?: string;
  }): Promise<null>;
  listSkills(
    moduleId?: Arguments<"skill.library.list">["moduleId"],
    userOnly?: boolean,
  ): Promise<ManagedSkill[]>;
  readSkillDocument(
    id: string,
    moduleId?: Arguments<"skill.library.read">["moduleId"],
  ): Promise<string>;
  createSkillDocument(input: { name: string; text: string }): Promise<ManagedSkill>;
  saveSkillDocument(input: { name: string; text: string }): Promise<ManagedSkill>;
  importSkillDirectory(): Promise<ManagedSkill | null>;
  createConversation(projectId: string): Promise<ConversationInfo>;
  deleteConversation(id: string): Promise<null>;
  updateConversation(change: Arguments<"conversation.update">): Promise<ConversationInfo>;
  watchConversation(id: string): Promise<ConversationView>;
  getConversationTrace(id: string): Promise<Results["conversation.trace"]>;
  getTraceDetail(id: string, entryId: string): Promise<Results["conversation.traceDetail"]>;
  sendMessage(
    id: string,
    requestId: string,
    text: string,
    images?: import("./application.ts").ChatImage[],
    delivery?: import("./application.ts").DeliveryMode,
  ): Promise<{ submissionId: string }>;
  stopConversation(id: string): Promise<null>;
  cancelQueuedMessage(id: string, messageId: string): Promise<null>;
  promoteQueuedMessage(id: string, messageId: string): Promise<null>;
  resumeConversationQueue(id: string): Promise<null>;
  // 工具确认和后端主动推送的状态。
  respondShell(id: string, approved: boolean): Promise<null>;
  subscribe(listener: (event: ApplicationEvent) => void): () => void;
}
