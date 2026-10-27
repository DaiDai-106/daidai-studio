import type {
  ApplicationEvent,
  ChatImage,
  ConversationInfo,
  ConversationView,
  LoginInfo,
  ModelChoice,
  ProjectInfo,
  ProviderConfig,
  ProviderInfo,
  ProviderTypeInfo,
  SettingsInfo,
  ThinkingLevel,
  WorkspaceInfo,
} from "./application.ts";
import type { McpConfig, McpInspection, SkillConfig, SkillImage } from "./capabilities.ts";
import type { Theme } from "./desktop.ts";
import type { ImportedModel } from "./display.ts";

export interface ApplicationBridge {
  getDisplay(id: string): Promise<ImportedModel | null>;
  saveMcp(config: McpConfig): Promise<McpConfig>;
  removeMcp(id: string): Promise<null>;
  inspectMcp(config: McpConfig, projectId: string): Promise<McpInspection>;
  cancelMcpInspection(id: string): Promise<null>;
  saveSkill(config: SkillConfig): Promise<SkillConfig>;
  addSkillImage(id: string, name: string, image: ChatImage): Promise<SkillImage>;
  readSkillImage(id: string, path: string): Promise<ChatImage>;
  removeSkillImage(id: string, path: string): Promise<null>;
  removeSkill(id: string): Promise<null>;
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
  setCapabilityEnabled(
    id:
      | "builtin.cad"
      | "builtin.alignment"
      | "builtin.viewport"
      | "builtin.scene-profiles"
      | "builtin-scene"
      | "builtin-alignment-skill",
    enabled: boolean,
  ): Promise<SettingsInfo>;
  startLogin(providerType: string, method: "api_key" | "oauth"): Promise<LoginInfo>;
  answerLogin(id: string, promptId: string, value: string): Promise<LoginInfo>;
  cancelLogin(id: string): Promise<null>;
  getLogin(id: string): Promise<LoginInfo>;
  openLogin(id: string): Promise<null>;
  openProject(): Promise<ProjectInfo | null>;
  refreshProject(id: string): Promise<ProjectInfo>;
  removeProject(id: string): Promise<null>;
  createConversation(projectId: string): Promise<ConversationInfo>;
  deleteConversation(id: string): Promise<null>;
  selectStep(id: string, relativePath: string): Promise<ConversationInfo>;
  updateConversation(change: {
    id: string;
    title?: string;
    mode?: "general" | "scene";
    modelId?: string;
    thinkingLevel?: ThinkingLevel;
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
  startScene(id: string): Promise<null>;
  stopConversation(id: string): Promise<null>;
  respondShell(id: string, approved: boolean): Promise<null>;
  respondViewport(
    id: string,
    capture: import("./application.ts").ViewportCapture | null,
  ): Promise<null>;
  subscribe(listener: (event: ApplicationEvent) => void): () => void;
}
