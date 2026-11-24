import { execSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getShellConfig, type McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";

function runConfigCommand(command: string) {
  const options = { encoding: "utf8", timeout: 10_000, windowsHide: true } as const;
  if (process.platform === "win32") {
    const { shell, args, commandTransport } = getShellConfig();
    const fromStdin = commandTransport === "stdin";
    const result = spawnSync(shell, fromStdin ? args : [...args, command], {
      ...options,
      stdio: [fromStdin ? "pipe" : "ignore", "pipe", "ignore"],
      ...(fromStdin ? { input: command } : {}),
    });
    if (result.status === 0) return result.stdout.trim();
    if (!result.error || (result.error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  return execSync(command, { ...options, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function resolveValues(values: Record<string, string> | undefined, server: string) {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => {
      try {
        if (value.startsWith("!")) {
          const output = runConfigCommand(value.slice(1));
          if (!output) throw new Error();
          return [key, output];
        }
        const resolved = value.replace(/\$\$|\$!|\$\{[^}]*\}|\$[A-Za-z_]\w*/gu, (reference) => {
          if (reference === "$$" || reference === "$!") return reference.slice(1);
          const name = reference.startsWith("${") ? reference.slice(2, -1) : reference.slice(1);
          if (!/^[A-Za-z_]\w*$/u.test(name)) return reference;
          const configured = process.env[name];
          if (!configured) throw new Error();
          return configured;
        });
        return [key, resolved];
      } catch {
        throw new Error(`无法解析 MCP 服务 ${server} 的配置项 ${key}。`);
      }
    }),
  );
}

function expandHome(value: string) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")))
    return join(homedir(), value.slice(2));
  return value;
}

// Pi 的自定义 transport 接管会话内全部服务，普通服务仍使用标准 HTTP 或 stdio。
export const createStandardMcpTransport: McpTransportFactory = (
  { name, config },
  cwd,
  authProvider,
) =>
  "url" in config
    ? new StreamableHttpTransport({
        url: config.url,
        headers: resolveValues(config.headers, name),
        ...(authProvider ? { authProvider } : {}),
      })
    : new StdioTransport({
        command: expandHome(config.command),
        ...(config.args ? { args: config.args.map(expandHome) } : {}),
        cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
        env: resolveValues(config.env, name),
        stderr: "pipe",
      });
