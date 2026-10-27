import type { McpConfig } from "../../shared/capabilities.ts";
import type { McpServer } from "../types.ts";

export function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validMcpConfig(draft: McpServer): boolean {
  return (
    !!draft.name.trim() &&
    !!draft.target.trim() &&
    (draft.transport === "stdio" || validUrl(draft.target)) &&
    draft.modes.length > 0 &&
    Number.isInteger(draft.timeout) &&
    draft.timeout > 0 &&
    draft.timeout <= 300 &&
    draft.args.length <= 100 &&
    draft.args.every((arg) => arg.length <= 4096) &&
    (draft.secrets?.length ?? 0) <= 100 &&
    (draft.secrets ?? []).every(
      ({ name, value }) => !!name.trim() && name.length <= 200 && (value?.length ?? 0) <= 8192,
    )
  );
}

export function parseMcpConfig(
  json: string,
): Pick<McpServer, "name" | "transport" | "target" | "args" | "secrets"> {
  const data: unknown = JSON.parse(json);
  if (!isRecord(data) || !isRecord(data.mcpServers)) throw new Error("需要包含 mcpServers 对象。");
  const entries = Object.entries(data.mcpServers);
  const entry = entries[0];
  if (entries.length !== 1 || !entry || !isRecord(entry[1]))
    throw new Error("一次只支持导入一个服务。");
  const [name, config] = entry;
  if (!name.trim()) throw new Error("服务名称不能为空。");
  const command = config.command;
  const url = config.url;
  if ((typeof command === "string") === (typeof url === "string"))
    throw new Error("请填写 command 或 url 中的一种，不能同时填写。");
  if (typeof command === "string" && !command.trim()) throw new Error("command 不能为空。");
  if (typeof url === "string" && !validUrl(url))
    throw new Error("url 必须是有效的 HTTP / HTTPS 地址。");
  const args = config.args ?? [];
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string"))
    throw new Error("args 必须是字符串数组。");
  const rawSecrets = typeof command === "string" ? config.env : config.headers;
  if (
    rawSecrets !== undefined &&
    (!isRecord(rawSecrets) || Object.values(rawSecrets).some((value) => typeof value !== "string"))
  )
    throw new Error("env 和 headers 必须是字符串键值对象。");
  const secrets = isRecord(rawSecrets)
    ? Object.entries(rawSecrets).map(([name, value]) => ({ name, value: value as string }))
    : [];
  return {
    name,
    ...(secrets.length ? { secrets } : {}),
    transport: typeof command === "string" ? "stdio" : "http",
    target: typeof command === "string" ? command : typeof url === "string" ? url : "",
    args,
  };
}

export function mcpConfig(server: McpServer): McpConfig {
  if (!validMcpConfig(server))
    throw new Error("请填写名称、有效连接、适用模式及 1–300 秒整数超时。");
  const common = {
    id: server.id,
    name: server.name.trim(),
    enabled: server.enabled,
    scope: server.scope,
    modes: server.modes,
    timeoutMs: server.timeout * 1000,
    ...(server.secrets?.length ? { secrets: server.secrets } : {}),
  };
  return server.transport === "stdio"
    ? { ...common, transport: "stdio", command: server.target.trim(), args: server.args }
    : { ...common, transport: "http", url: server.target.trim() };
}

export function mcpServer(config: McpConfig): McpServer {
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    scope: config.scope,
    modes: config.modes,
    timeout: config.timeoutMs / 1000,
    builtin: false,
    checked: false,
    transport: config.transport,
    target: config.transport === "stdio" ? config.command : config.url,
    args: config.transport === "stdio" ? config.args : [],
    ...(config.secrets?.length ? { secrets: config.secrets } : {}),
  };
}
