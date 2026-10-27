import { pathToFileURL } from "node:url";
import type { Tool } from "@earendil-works/pi-mcp";
import { Compile } from "typebox/compile";
import type { McpConfig, McpInspection } from "../../shared/capabilities.ts";
import { type McpConnection, openMcpConnection } from "./connection.ts";

export function normalizeMcpConfig(config: McpConfig): McpConfig {
  if (config.id.startsWith("builtin")) throw new Error("内置 MCP 配置不能覆盖。");
  if (!config.name.trim()) throw new Error("MCP 服务名称不能为空。");
  if (config.transport === "stdio") {
    if (!config.command.trim()) throw new Error("MCP 启动命令不能为空。");
    return { ...config, name: config.name.trim(), command: config.command.trim() };
  }
  const url = new URL(config.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("MCP 地址需要 HTTP/HTTPS，且不能包含用户名、密码或片段。");
  return { ...config, name: config.name.trim(), url: url.href };
}

export async function connectConfiguredMcp(
  config: McpConfig,
  project: { id: string; name: string; path: string },
  signal: AbortSignal,
  secrets: Record<string, string> = {},
) {
  const value = normalizeMcpConfig(config);
  if (value.scope.kind === "project" && value.scope.projectId !== project.id)
    throw new Error("MCP 服务不属于当前项目。");
  return openMcpConnection(
    value.transport === "stdio"
      ? {
          kind: "stdio",
          options: {
            command: value.command,
            args: value.args,
            cwd: project.path,
            stderr: "pipe",
            env: secrets,
          },
        }
      : {
          kind: "http",
          options: {
            url: value.url,
            headers: secrets,
            ...(Object.keys(secrets).length
              ? {
                  fetch: (input: string | URL, init?: RequestInit) =>
                    fetch(input, { ...init, redirect: "error" }),
                }
              : {}),
          },
        },
    {
      signal,
      client: {
        name: "dai",
        version: "0.1.0",
        requestTimeoutMs: value.timeoutMs,
        ...(value.transport === "stdio"
          ? { roots: [{ uri: pathToFileURL(project.path).href, name: project.name }] }
          : {}),
      },
    },
  );
}

export async function discoverMcpTools(
  connection: McpConnection,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Tool[]> {
  const tools = await connection.client.listTools({ signal, timeoutMs });
  if (tools.length > 500) throw new Error("单个 MCP 服务最多接入 500 个工具。");
  const names = new Set<string>();
  for (const tool of tools) {
    signal.throwIfAborted();
    if (
      typeof tool.name !== "string" ||
      !tool.name ||
      tool.name.length > 200 ||
      names.has(tool.name) ||
      !tool.inputSchema ||
      typeof tool.inputSchema !== "object" ||
      tool.inputSchema.type !== "object"
    )
      throw new Error("MCP 工具名称或输入定义无效。");
    if (Buffer.byteLength(JSON.stringify(tool.inputSchema)) > 128000)
      throw new Error("MCP 工具输入定义超过大小限制。");
    Compile(tool.inputSchema); // Reuse the same schema compiler as Pi's ToolTask validation.
    names.add(tool.name);
  }
  return tools;
}

export async function inspectMcp(
  config: McpConfig,
  project: { id: string; name: string; path: string },
  signal: AbortSignal,
  secrets: Record<string, string> = {},
): Promise<McpInspection> {
  try {
    const connection = await connectConfiguredMcp(config, project, signal, secrets);
    try {
      const tools = await discoverMcpTools(connection, config.timeoutMs, signal);
      return {
        serverName: (connection.client.serverInfo?.name ?? "").slice(0, 200),
        serverVersion: (connection.client.serverInfo?.version ?? "").slice(0, 200),
        tools: tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description.slice(0, 2000) } : {}),
        })),
      };
    } finally {
      await connection.close();
    }
  } catch (error) {
    if (signal.aborted)
      throw new Error(
        signal.reason?.name === "TimeoutError" ? "MCP 连接检查超时。" : "MCP 连接检查已停止。",
      );
    if (error instanceof Error && error.message.startsWith("MCP 工具")) throw error;
    throw new Error("无法检查 MCP 服务，请确认命令、地址和服务配置。");
  }
}
