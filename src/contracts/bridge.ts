import type {
  AccessMode,
  ApplicationEvent,
  ConversationInfo,
  ConversationView,
  LoginInfo,
  ManagedSkill,
  ModelChoice,
  PackageInfo,
  PackageScope,
  ProjectInfo,
  ProviderConfig,
  ProviderInfo,
  ProviderTypeInfo,
  ScenePythonStatus,
  SceneTransform,
  SceneView,
  SettingsInfo,
  ThinkingLevel,
  WorkspaceInfo,
} from "./application.ts";
import type { ConversationMode } from "./capabilities.ts";
import type { Theme } from "./desktop.ts";

// 渲染界面可通过 preload 调用的应用接口；具体执行交给桌面进程和后端。
export interface ApplicationBridge {
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
  updateSettings(change: {
    theme?: Theme;
    defaultModel?: string;
    showThinking?: boolean;
  }): Promise<SettingsInfo>;

  // 认证交互由后端维护状态，前端只提交当前步骤的回答。
  startLogin(providerType: string, method: "api_key" | "oauth"): Promise<LoginInfo>;
  answerLogin(id: string, promptId: string, value: string): Promise<LoginInfo>;
  cancelLogin(id: string): Promise<null>;
  getLogin(id: string): Promise<LoginInfo>;
  openLogin(id: string): Promise<null>;

  // 项目路径通过系统选择器获取，对话保存和发送使用对话 ID。
  chooseProjectDirectory(): Promise<{ token: string; path: string } | null>;
  createProject(input: {
    name: string;
    mode: ConversationMode;
    directoryToken?: string;
  }): Promise<ProjectInfo | null>;
  refreshProject(id: string): Promise<ProjectInfo>;
  removeProject(id: string): Promise<null>;
  listHiddenProjects(): Promise<ProjectInfo[]>;
  restoreProject(id: string): Promise<ProjectInfo>;

  getProjectScene(projectId: string): Promise<SceneView>;
  getScenePythonStatus(): Promise<ScenePythonStatus>;
  installScenePython(): Promise<ScenePythonStatus>;
  cancelSceneImport(projectId: string): Promise<null>;
  relocateSceneSource(input: {
    projectId: string;
    modelId: string;
    revision: number;
  }): Promise<SceneView | null>;
  importStep(input: {
    projectId: string;
    operation: "replace" | "append";
    revision: number;
  }): Promise<SceneView | null>;
  importDroppedStep(
    file: File,
    input: {
      projectId: string;
      operation: "replace" | "append";
      revision: number;
    },
  ): Promise<SceneView>;
  setSceneTransform(input: {
    projectId: string;
    modelId: string;
    objectId: string;
    revision: number;
    transform: SceneTransform;
  }): Promise<SceneView>;
  deleteSceneObject(input: {
    projectId: string;
    modelId: string;
    objectId: string;
    revision: number;
  }): Promise<SceneView>;
  confirmSceneJoint(input: {
    projectId: string;
    candidateId: string;
    revision: number;
  }): Promise<SceneView>;
  discardSceneJointDraft(input: {
    projectId: string;
    candidateId: string;
    revision: number;
  }): Promise<SceneView>;
  removeConfirmedSceneJoint(input: {
    projectId: string;
    candidateId: string;
    revision: number;
  }): Promise<SceneView>;
  forkConversation(id: string): Promise<ConversationInfo>;
  listPackages(projectId?: string): Promise<PackageInfo[]>;
  updatePackage(input: { projectId?: string; source?: string }): Promise<null>;
  respondExtensionUi(input: {
    requestId: string;
    cancelled: boolean;
    value?: string;
  }): Promise<null>;
  installPackage(input: { source: string; scope: PackageScope; projectId?: string }): Promise<null>;
  removePackage(input: { source: string; scope: PackageScope; projectId?: string }): Promise<null>;
  setPackageEnabled(input: {
    source: string;
    scope: PackageScope;
    projectId?: string;
    enabled: boolean;
  }): Promise<null>;
  listSkills(projectId?: string): Promise<ManagedSkill[]>;
  readSkillDocument(id: string, projectId?: string): Promise<string>;
  createSkillDocument(input: { name: string; text: string }): Promise<ManagedSkill>;
  saveSkillDocument(input: { name: string; text: string }): Promise<ManagedSkill>;
  importSkillDirectory(): Promise<ManagedSkill | null>;
  createConversation(projectId: string): Promise<ConversationInfo>;
  deleteConversation(id: string): Promise<null>;
  updateConversation(change: {
    id: string;
    title?: string;
    modelId?: string;
    thinkingLevel?: ThinkingLevel;
    accessMode?: AccessMode;
    draft?: string;
    archived?: boolean;
  }): Promise<ConversationInfo>;
  watchConversation(id: string): Promise<ConversationView>;
  sendMessage(
    id: string,
    requestId: string,
    text: string,
    images?: import("./application.ts").ChatImage[],
    sceneReference?: import("./application.ts").SceneReference,
  ): Promise<{ submissionId: string }>;
  stopConversation(id: string): Promise<null>;
  // 工具确认和后端主动推送的状态。
  respondShell(id: string, approved: boolean): Promise<null>;
  subscribe(listener: (event: ApplicationEvent) => void): () => void;
}
