import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type {
  LoadedMcpConfig,
  McpExposure,
  McpServerConfig,
  McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import { isMcpServerOverride, mcpNamespace, validateMcpServerConfig } from "@earendil-works/pi-mcp";
import { type McpScope, maxMcpConfigLength } from "../../contracts/application.ts";
import type { PluginModule } from "../../contracts/catalog.ts";
import { nearestExistingPath } from "../../shared/node/file_access.ts";
import { writeAtomic } from "../../shared/node/write_json.ts";

const emptyConfig = '{\n  "mcpServers": {}\n}\n';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
type RegisteredServer = McpServerEntry & { label?: string };

function parseExposure(value: unknown): McpExposure {
  if (value === "codemode-deferred") return "codemode";
  if (value === "codemode" || value === "direct" || value === "deferred" || value === "hidden")
    return value;
  throw new Error("工具暴露方式应为 codemode、direct、deferred 或 hidden。");
}

function parseServerConfig(name: string, input: unknown): McpServerConfig {
  const validated = validateMcpServerConfig(name, input);
  if (validated.kind === "invalid") throw new Error(validated.error);
  if (validated.config.auth !== undefined)
    throw new Error("请使用 headers 或 OAuth 配置 MCP 认证。");

  const { exposure, toolExposure, label: _label, ...transport } = validated.config;
  const config: McpServerConfig = transport;
  if (exposure !== undefined) config.exposure = parseExposure(exposure);
  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure)) throw new Error("toolExposure 必须是工具名称到暴露方式的映射。");
    config.toolExposure = Object.fromEntries(
      Object.entries(toolExposure).map(([tool, mode]) => [tool, parseExposure(mode)]),
    );
  }
  return config;
}

function parseConfig(
  text: string,
  source: string,
  scopeId?: McpScope,
  inherited?: ReadonlyMap<string, McpServerEntry>,
) {
  const servers = new Map<string, RegisteredServer>();
  const errors: string[] = [];
  let document: unknown;
  try {
    document = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    return { servers, errors: ["MCP 配置必须是有效的 JSON。"] };
  }
  if (!isRecord(document) || !isRecord(document.mcpServers))
    return { servers, errors: ['MCP 配置需要一个 "mcpServers" 对象。'] };

  const scope = scopeId ? "project" : "global";
  for (const [name, value] of Object.entries(document.mcpServers)) {
    try {
      const namespace = mcpNamespace(name);
      if (servers.has(namespace)) throw new Error("此作用域内已有使用相同工具命名空间的服务。");
      let label: string | undefined;
      if (scopeId === "process") {
        if (name.length > 200) throw new Error("工艺 MCP 服务名称最多 200 个字符。");
        if (isRecord(value) && value.label !== undefined) {
          if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 200)
            throw new Error("工艺 MCP 的 label 应为 1 至 200 个字符的显示名称。");
          label = value.label.trim();
        }
      }
      let config = value;
      if (inherited && isRecord(value) && isMcpServerOverride(value)) {
        const base = inherited.get(namespace);
        if (!base) throw new Error("请提供 command 或 url，或配置对应的全局服务。");
        if (
          Object.keys(value).some((key) => !["enabled", "exposure", "toolExposure"].includes(key))
        )
          throw new Error("全局服务覆盖项仅支持 enabled、exposure 和 toolExposure。");
        config = { ...base.config, ...value };
      }
      servers.set(namespace, {
        name,
        source,
        scope,
        config: parseServerConfig(name, config),
        ...(label ? { label } : {}),
      });
    } catch (error) {
      errors.push(`${name.slice(0, 200)}：${(error as Error).message}`);
    }
  }
  return { servers, errors };
}

export function mcpConfigDirectory(dataRoot: string) {
  return join(dataRoot, "agent", "mcp");
}

function configPath(dataRoot: string, scope?: McpScope) {
  const directory = mcpConfigDirectory(dataRoot);
  if (scope === "process") return join(directory, scope, "mcp.json");
  return scope ? join(directory, "modules", scope, "mcp.json") : join(directory, "mcp.json");
}

async function checkConfigPath(path: string) {
  // 文件尚未保存时，也要检查最近的现有父目录。
  const { path: existing, info } = await nearestExistingPath(path, true);
  if (info.isSymbolicLink() || relative(existing, await realpath(existing)))
    throw new Error("MCP 配置路径不能通过符号链接重定向。");
  return existing === path ? info : undefined;
}

async function readConfigText(path: string, fallback = emptyConfig) {
  const info = await checkConfigPath(path);
  if (!info) return fallback;
  if (!info.isFile()) throw new Error("MCP 配置必须是普通文件。");
  const text = await readFile(path, "utf8");
  if (text.length > maxMcpConfigLength) throw new Error("MCP 配置超过长度限制。");
  return text;
}

export function readMcpConfig(dataRoot: string, scope?: McpScope) {
  return readConfigText(configPath(dataRoot, scope));
}

async function readMcpAuth(path: string) {
  const text = await readConfigText(path, "{}");
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

type McpCertificateBinding = { certificateDirectory?: string; protectedPrivateKeys: string[] };

export async function readMcpCertificateBinding(
  dataRoot: string,
  service: string,
): Promise<McpCertificateBinding> {
  const auth = await readMcpAuth(join(mcpConfigDirectory(dataRoot), "auth.json"));
  const entry = auth[service];
  if (!isRecord(entry)) return { protectedPrivateKeys: [] };
  const { certificateDirectory, protectedPrivateKeys } = entry;
  return {
    ...(typeof certificateDirectory === "string" && isAbsolute(certificateDirectory)
      ? { certificateDirectory }
      : {}),
    protectedPrivateKeys: Array.isArray(protectedPrivateKeys)
      ? protectedPrivateKeys.filter(
          (path): path is string => typeof path === "string" && isAbsolute(path),
        )
      : [],
  };
}

export async function saveMcpCertificateBinding(
  dataRoot: string,
  service: string,
  binding: McpCertificateBinding,
) {
  const root = mcpConfigDirectory(dataRoot);
  const path = join(root, "auth.json");
  const auth = await readMcpAuth(path);
  const text = `${JSON.stringify({ ...auth, [service]: binding }, null, 2)}\n`;
  if (text.length > maxMcpConfigLength) throw new Error("MCP 认证配置超过长度限制。");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeAtomic(path, text);
}

async function loadScope(
  dataRoot: string,
  scope?: McpScope,
  inherited?: ReadonlyMap<string, McpServerEntry>,
) {
  try {
    const path = configPath(dataRoot, scope);
    return parseConfig(await readConfigText(path), path, scope, inherited);
  } catch (error) {
    return {
      servers: new Map<string, RegisteredServer>(),
      errors: [error instanceof Error ? error.message : "无法读取 MCP 配置。"],
    };
  }
}

export async function readProcessMcpOptions(dataRoot: string) {
  const { servers, errors } = await loadScope(dataRoot, "process");
  if (errors.length) {
    return {
      servers: [],
      configError: `无法读取工艺 MCP 配置。${errors.join("\n")}`.slice(0, 4000),
    };
  }
  return {
    servers: [...servers.values()]
      .filter(({ config }) => config.enabled !== false)
      .map(({ name, label }) => ({ id: name, label: label ?? name })),
  };
}

export async function loadMcpConfig(
  dataRoot: string,
  moduleId: PluginModule,
  processServer?: string | null,
): Promise<LoadedMcpConfig> {
  const global = await loadScope(dataRoot);
  const local = await loadScope(dataRoot, moduleId, global.servers);
  const errors = [
    ...global.errors.map((error) => `全局 · ${error}`),
    ...local.errors.map((error) => `${moduleId} · ${error}`),
  ];
  const servers = new Map([...global.servers, ...local.servers]);
  if (moduleId === "planning" && processServer && !processServer.startsWith("builtin:")) {
    const process = await loadScope(dataRoot, "process");
    errors.push(...process.errors.map((error) => `工艺 · ${error}`));
    const namespace = mcpNamespace(processServer);
    const selected = process.servers.get(namespace);
    if (selected?.name === processServer && selected.config.enabled !== false)
      servers.set(namespace, selected);
  }
  // 无法确认模块覆盖时，暂停连接，避免已停用的全局服务重新出现。
  return {
    servers: errors.length ? [] : [...servers.values()],
    errors,
  };
}

export async function saveMcpConfig(
  dataRoot: string,
  scope: McpScope | undefined,
  text: string,
  beforeSave: () => Promise<void>,
) {
  const path = configPath(dataRoot, scope);
  const inherited = scope && scope !== "process" ? (await loadScope(dataRoot)).servers : undefined;
  const { errors } = parseConfig(text, path, scope, inherited);
  if (errors.length) throw new Error(errors[0]);
  const directory = dirname(path);
  await checkConfigPath(directory);
  await beforeSave();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeAtomic(path, text);
}
