import type { McpConfig } from "../../shared/capabilities.ts";
import type { StoredMcpConfig } from "../settings/documents.ts";
import type { Settings } from "../settings/handlers.ts";

// Credential values are staged in the OS vault, never in the settings journal.
export async function resolveMcpSecrets(
  settings: Pick<Settings, "credentials">,
  config: McpConfig,
  previous?: StoredMcpConfig,
): Promise<Record<string, string>> {
  const old =
    previous?.transport === config.transport && previous.secretRef
      ? await settings.credentials.readReference(previous.secretRef)
      : undefined;
  let stored: Record<string, string> = {};
  if (old?.type === "api_key" && typeof old.key === "string") {
    try {
      stored = JSON.parse(old.key) as Record<string, string>;
    } catch {
      throw new Error("MCP 安全配置无法读取，请重新填写。");
    }
  }
  const values: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  for (const item of config.secrets ?? []) {
    const name = item.name.trim();
    const identity = config.transport === "http" ? name.toLowerCase() : name;
    if (
      seen.has(identity) ||
      (config.transport === "stdio" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
      (config.transport === "http" &&
        (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
          /^(host|content-length|transfer-encoding|connection|accept|content-type|mcp-session-id|mcp-protocol-version|last-event-id)$/i.test(
            name,
          )))
    )
      throw new Error("MCP 环境变量或 Header 名称无效、重复或由协议保留。");
    const value = item.value ?? stored[name];
    if (typeof value !== "string") throw new Error(`请重新填写 ${name} 的值。`);
    if (value.includes("\0") || (config.transport === "http" && /[\r\n]/.test(value)))
      throw new Error("MCP 环境变量或 Header 值无效。");
    values[name] = value;
    seen.add(identity);
  }
  return values;
}
