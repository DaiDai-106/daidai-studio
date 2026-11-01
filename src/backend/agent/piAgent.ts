import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ExtensionUIContext,
  type ModelRuntime,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ConversationMode } from "../../contracts/capabilities.ts";
import { createPackageMcpCredentials } from "../extensions/packageMcpCredentials.ts";
import type { createPackageService } from "../extensions/packageService.ts";
import { createFileAccess } from "./fileAccess.ts";
import type { createPiHistory } from "./piHistory.ts";

const prompts: Record<ConversationMode, string> = {
  general: "你是 Dai 助手，帮助用户分析问题和使用项目工具。只报告真实执行过的结果。",
  scene:
    "你是 Dai 场景搭建助手。场景属于项目，所有会话共享同一场景。仅根据工具结果报告场景；修改前确认用户意图。",
  robot: "你是 Dai 机器人助手。仅以用户提供的信息或真实工具结果判断设备状态。",
};

/** 在项目上下文中创建 Pi 会话，资源只来自 Dai 管理的 Pi 包。 */
export async function createPiAgent(options: {
  conversationId: string;
  cwd: string;
  dataRoot: string;
  mode: ConversationMode;
  history: ReturnType<typeof createPiHistory>;
  packages: ReturnType<typeof createPackageService>;
  modelRuntime: ModelRuntime;
  model?: Model<Api>;
  packageMcpCredentials?: Awaited<ReturnType<typeof createPackageMcpCredentials>>;
  shellApproval?: ExtensionFactory;
  uiContext?: ExtensionUIContext;
  approvedFiles?: () => readonly string[];
  fullAccess?: () => boolean;
  customTools?: ToolDefinition[];
  skillPaths?: string[];
}) {
  const resources = await options.packages.resolve();
  const enabled = (items: typeof resources.extensions) =>
    items.filter((item) => item.enabled).map((item) => item.path);
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
  const agentDir = join(options.dataRoot, "pi");
  const mcpCredentials = options.packageMcpCredentials ?? (await createPackageMcpCredentials());
  const loader: DefaultResourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    disabledBuiltinExtensions: ["mcp"],
    // 只处理 Pi package 注册的服务，不读取工作区或全局 mcp.json。
    extensionFactories: [
      createFileAccess({
        cwd: options.cwd,
        skillRoots: () => loader.getSkills().skills.map((skill) => skill.baseDir),
        ...(options.approvedFiles ? { approvedFiles: options.approvedFiles } : {}),
        ...(options.fullAccess ? { fullAccess: options.fullAccess } : {}),
      }),
      ...(options.shellApproval ? [options.shellApproval] : []),
      createMcpExtension({
        loadConfig: () => ({ servers: [], errors: [] }),
        credentials: mcpCredentials.credentials,
        logPath: join(options.dataRoot, "logs", "package-mcp.log"),
      }),
    ],
    additionalExtensionPaths: enabled(resources.extensions),
    additionalSkillPaths: [...enabled(resources.skills), ...(options.skillPaths ?? [])],
    additionalPromptTemplatePaths: enabled(resources.prompts),
    additionalThemePaths: enabled(resources.themes),
    systemPrompt: prompts[options.mode],
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length)
    throw new Error(`Pi 扩展加载失败：${errors.map((item) => item.error).join("；")}`);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    sessionManager: options.history.open(options.conversationId),
    modelRuntime: options.modelRuntime,
    ...(options.model ? { model: options.model } : {}),
    settingsManager,
    resourceLoader: loader,
    ...(options.customTools ? { customTools: options.customTools } : {}),
  });
  try {
    await session.bindExtensions(
      options.uiContext ? { uiContext: options.uiContext, mode: "rpc" } : {},
    );
  } catch (error) {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
    throw error;
  }
  return session;
}
