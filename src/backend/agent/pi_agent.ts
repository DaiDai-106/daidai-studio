import { join } from "node:path";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  type ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PackageLoad } from "../../contracts/catalog.ts";
import type { createPackageService } from "../extensions/package_service.ts";
import { createFileAccess } from "./file_access.ts";
import type { AgentModuleConfig } from "./module_config.ts";
import type { createPiHistory } from "./pi_history.ts";

/** 在项目上下文创建 Pi 会话；包由 Dai 管理，Coding 指令使用 Pi 原生发现。 */
export async function createPiAgent(options: {
  conversationId: string;
  onPackageLoad?: (entries: PackageLoad[]) => void;
  cwd: string;
  dataRoot: string;
  history: ReturnType<typeof createPiHistory>;
  packages: ReturnType<typeof createPackageService>;
  modelRuntime: ModelRuntime;
  moduleConfig: AgentModuleConfig;
  model?: Model<Api>;
  uiContext?: ExtensionUIContext;
  beforePrompt?: () => void;
  skillPaths?: string[];
}) {
  // 此服务只读取 agent/packages；桌面插件的安装配置不进入 Pi 发现链。
  const resources = await options.packages.resolve();
  const {
    allowPackageExtensions,
    disabledBuiltinExtensions,
    extensionFactories,
    fullAccess,
    literalFilePaths,
    systemPrompt,
    tools,
  } = options.moduleConfig;
  const enabled = (items: typeof resources.extensions) =>
    items.filter((item) => item.enabled).map((item) => item.path);
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
  const agentDir = join(options.dataRoot, "agent");
  const loader: DefaultResourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: false,
    disabledBuiltinExtensions,
    extensionFactories: [
      createFileAccess({
        cwd: options.cwd,
        skillRoots: () => loader.getSkills().skills.map((skill) => skill.baseDir),
        literalFilePaths: literalFilePaths === true,
        ...(fullAccess ? { fullAccess } : {}),
      }),
      ...extensionFactories,
    ],
    additionalExtensionPaths: allowPackageExtensions ? enabled(resources.extensions) : [],
    additionalSkillPaths: [...enabled(resources.skills), ...(options.skillPaths ?? [])],
    additionalPromptTemplatePaths: enabled(resources.prompts),
    additionalThemePaths: enabled(resources.themes),
    systemPrompt,
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  // 导入失败按路径记录，绑定失败作用于整次会话；两者使用相同的来源与作用域映射。
  const report = (errorFor: (path: string) => string) =>
    options.onPackageLoad?.(
      (allowPackageExtensions ? resources.extensions : [])
        .filter((r) => r.enabled)
        .map((r) => ({
          source: r.metadata.source,
          scope: r.metadata.scope === "user" ? "global" : "module",
          error: errorFor(r.path),
        })),
    );
  report((path) => errors.find((e) => e.path === path)?.error ?? "");
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
    ...(tools ? { tools } : {}),
  });
  // Pi 输入钩子先完成，再从 Core 的入口检查取消并确认提交。
  const { agent } = session;
  type Messages = typeof agent.state.messages;
  const prompt = agent.prompt.bind(agent);
  agent.prompt = async (input: string | Messages[number] | Messages, images?: ImageContent[]) => {
    options.beforePrompt?.();
    return typeof input === "string" ? prompt(input, images) : prompt(input);
  };
  try {
    await session.bindExtensions(
      options.uiContext ? { uiContext: options.uiContext, mode: "rpc" } : {},
    );
  } catch (error) {
    report(() => (error instanceof Error ? error.message : "扩展绑定失败。"));
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
    throw error;
  }
  return session;
}
