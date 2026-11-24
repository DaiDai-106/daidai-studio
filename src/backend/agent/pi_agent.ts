import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import {
  type CodemodeToolDetails,
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ExtensionUIContext,
  type ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PackageLoad } from "../../contracts/catalog.ts";
import { type BuiltinMcpConnection, createDaiMcpExtension } from "../extensions/mcp/extension.ts";
import type { createPackageService } from "../extensions/package_service.ts";
import { loadMcpConfig, mcpConfigDirectory } from "../settings/mcp.ts";
import { createFileAccess } from "./file_access.ts";
import type { AgentModuleConfig } from "./module_config.ts";
import type { createPiHistory } from "./pi_history.ts";

const mcpToolNames = [
  "mcp__*",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
];

function trackCodemodeOutputs(readableOutputs: Set<string>): ExtensionFactory {
  const codemode = createCodemodeExtension({ mode: "on", models: false });
  return (pi) =>
    codemode({
      ...pi,
      registerTool(tool) {
        pi.registerTool({
          ...tool,
          async execute(...args) {
            const result = await tool.execute(...args);
            const path = (result.details as CodemodeToolDetails | undefined)?.fullOutputPath;
            if (path) {
              const target = await realpath(path).catch(() => undefined);
              if (target) readableOutputs.add(target);
            }
            return result;
          },
        });
      },
    });
}

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
  processServer?: string | null;
  builtinMcp?: BuiltinMcpConnection | undefined;
  protectedPrivateKeys?: ReadonlySet<string> | undefined;
  model?: Model<Api>;
  uiContext?: ExtensionUIContext;
  beforePrompt?: () => void;
  skillPaths?: string[];
}) {
  const {
    allowPackageExtensions,
    allowedTools,
    extensionFactories,
    fullAccess,
    literalFilePaths,
    moduleId,
    systemPrompt,
  } = options.moduleConfig;
  const agentDir = join(options.dataRoot, "agent");
  const [resources, mcp] = await Promise.all([
    options.packages.resolve(),
    loadMcpConfig(options.dataRoot, moduleId, options.processServer),
  ]);
  const packageExtensions = allowPackageExtensions
    ? resources.extensions.filter((item) => item.enabled)
    : [];
  const enabledPaths = (items: typeof resources.extensions) =>
    items.filter((item) => item.enabled).map((item) => item.path);
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
  const needsToolSearch = mcp.servers.some(
    ({ config }) =>
      config.enabled !== false &&
      (config.exposure === "deferred" ||
        Object.values(config.toolExposure ?? {}).includes("deferred")),
  );
  // 场景和规划使用显式白名单。Coding 保留默认或历史工具，再追加 Code Mode。
  const sessionTools = allowedTools && [
    ...allowedTools,
    "codemode",
    ...(needsToolSearch ? ["tool_search"] : []),
    ...mcpToolNames,
  ];
  const readableOutputs = new Set<string>();
  const loader: DefaultResourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      createFileAccess({
        cwd: options.cwd,
        protectedWriteDirectory: mcpConfigDirectory(options.dataRoot),
        protectedPrivateKeys: options.protectedPrivateKeys,
        readableOutputs,
        skillRoots: () => loader.getSkills().skills.map((skill) => skill.baseDir),
        literalFilePaths: literalFilePaths === true,
        ...(fullAccess ? { fullAccess } : {}),
      }),
      ...extensionFactories,
      {
        name: "dai:codemode",
        factory: trackCodemodeOutputs(readableOutputs),
        replaceable: true,
      },
      {
        name: "dai:tool-search",
        factory: createToolSearchExtension(),
        replaceable: true,
      },
      {
        name: "dai:mcp",
        factory: createDaiMcpExtension(mcp, join(agentDir, "mcp.log"), options.builtinMcp),
      },
    ],
    additionalExtensionPaths: packageExtensions.map((item) => item.path),
    additionalSkillPaths: [...enabledPaths(resources.skills), ...(options.skillPaths ?? [])],
    additionalPromptTemplatePaths: enabledPaths(resources.prompts),
    additionalThemePaths: enabledPaths(resources.themes),
    systemPrompt,
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  // 导入失败按路径记录，绑定失败作用于整次会话；两者使用相同的来源与作用域映射。
  const reportPackageLoad = (errorFor: (path: string) => string) =>
    options.onPackageLoad?.(
      packageExtensions.map(({ metadata, path }) => ({
        source: metadata.source,
        scope: metadata.scope === "user" ? "global" : "module",
        error: errorFor(path),
      })),
    );
  reportPackageLoad((path) => errors.find((e) => e.path === path)?.error ?? "");
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
    tools: sessionTools ?? ["+codemode"],
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
    reportPackageLoad(() => (error instanceof Error ? error.message : "扩展绑定失败。"));
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
    throw error;
  }
  return session;
}
