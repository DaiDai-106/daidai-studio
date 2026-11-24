import {
  createMcpExtension,
  type ExtensionFactory,
  type LoadedMcpConfig,
  type McpExtensionOptions,
  type McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import { mcpNamespace, type StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { createStandardMcpTransport } from "./transport.ts";

export interface BuiltinMcpConnection {
  entry: McpServerEntry;
  createTransport(): StreamableHttpTransport;
}

export function createDaiMcpExtension(
  config: LoadedMcpConfig,
  logPath: string,
  builtin?: BuiltinMcpConnection,
): ExtensionFactory {
  if (config.errors.length)
    return (pi) => {
      pi.on("session_start", (_event, ctx) => {
        ctx.ui.notify(`MCP 已暂停。请在设置中修正配置。\n${config.errors.join("\n")}`, "warning");
      });
    };

  const options: McpExtensionOptions = { loadConfig: () => config, logPath };
  if (builtin) {
    // 即使证书不可用，选中的内置服务也保留工具命名空间。
    const namespace = mcpNamespace(builtin.entry.name);
    const servers = config.servers.filter(({ name }) => mcpNamespace(name) !== namespace);
    servers.push(builtin.entry);
    options.loadConfig = () => ({ ...config, servers });
    options.createTransport = (entry, cwd, authProvider) =>
      entry.source === builtin.entry.source && entry.name === builtin.entry.name
        ? builtin.createTransport()
        : createStandardMcpTransport(entry, cwd, authProvider);
  }
  const connectMcp = createMcpExtension(options);
  return (pi) =>
    connectMcp({
      ...pi,
      registerCommand(name, command) {
        pi.registerCommand(name, command);
        // Pi 会为同名命令编号，Dai 保留一个固定入口。
        if (name === "mcp") pi.registerCommand("dai-mcp", command);
      },
    });
}
