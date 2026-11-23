import { join } from "node:path";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ExtensionUIContext,
  type ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PackageLoad } from "../../contracts/catalog.ts";
import { productName } from "../../shared/app_metadata.ts";
import type { createPackageService } from "../extensions/package_service.ts";
import { createFileAccess } from "./file_access.ts";
import type { createPiHistory } from "./pi_history.ts";
import { sceneToolNames } from "./scene_tools.ts";

const systemPrompt = `你是 ${productName} 编程助手，帮助用户理解和修改项目代码。只报告真实执行过的操作与结果。`;

/** 在项目上下文创建 Pi 会话；包由 Dai 管理，Coding 指令使用 Pi 原生发现。 */
export async function createPiAgent(options: {
  conversationId: string;
  onPackageLoad?: (entries: PackageLoad[]) => void;
  cwd: string;
  dataRoot: string;
  history: ReturnType<typeof createPiHistory>;
  packages: ReturnType<typeof createPackageService>;
  modelRuntime: ModelRuntime;
  model?: Model<Api>;
  shellApproval?: ExtensionFactory;
  sceneTools?: ExtensionFactory;
  uiContext?: ExtensionUIContext;
  beforePrompt?: () => void;
  fullAccess?: () => boolean;
  skillPaths?: string[];
}) {
  // 此服务只读取 agent/packages；桌面插件的安装配置不进入 Pi 发现链。
  const resources = await options.packages.resolve();
  const scene = options.sceneTools;
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
    disabledBuiltinExtensions: scene ? ["mcp", "codemode", "tool-search"] : ["mcp"],
    extensionFactories: [
      createFileAccess({
        cwd: options.cwd,
        skillRoots: () => loader.getSkills().skills.map((skill) => skill.baseDir),
        ...(options.fullAccess ? { fullAccess: options.fullAccess } : {}),
      }),
      ...(scene ? [scene] : options.shellApproval ? [options.shellApproval] : []),
    ],
    additionalExtensionPaths: scene ? [] : enabled(resources.extensions),
    additionalSkillPaths: [...enabled(resources.skills), ...(options.skillPaths ?? [])],
    additionalPromptTemplatePaths: enabled(resources.prompts),
    additionalThemePaths: enabled(resources.themes),
    systemPrompt: scene
      ? `你是 ${productName} 场景搭建助手。先用 scene_get 读取模型与版本，再调用场景工具。用户要求导入 STEP 或只发送 STEP 附件时，从用户消息的 [STEP 附件] 取 id 调用 scene_import_step。导入成功会替换当前场景，原始装配在原始模型中，构建场景仅有空的 base_link。用户可在原始模型下方属性区选择零件、分配或创建 Link/Joint，两个视图编辑同一份 URDF 配置；当前工具不提供零件分配和关节结构编辑，不要声称已执行这些操作。导入失败、取消或版本冲突时，告知用户并等待新的导入请求。只报告实际提交的修改。`
      : systemPrompt,
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  // 导入失败按路径记录，绑定失败作用于整次会话；两者使用相同的来源与作用域映射。
  const report = (errorFor: (path: string) => string) =>
    options.onPackageLoad?.(
      (scene ? [] : resources.extensions)
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
    ...(scene ? { tools: ["read", "ls", "find", "grep", ...Object.values(sceneToolNames)] } : {}),
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
