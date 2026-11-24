import { createHash, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { createSecureContext } from "node:tls";
import { McpClient, type McpFetch, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { Pool } from "undici";
import { readBoundedFile } from "../../../shared/node/file_access.ts";
import { withProjectDirectory } from "../../projects/project_access.ts";
import type { BuiltinMcpConnection } from "./extension.ts";

const maxPemLength = 64 * 1024;
const privateKeyFile = "device.key";

export async function rememberMcpPrivateKey(paths: Set<string>, directory?: string) {
  if (!directory || !isAbsolute(directory)) return;
  const path = join(directory, privateKeyFile);
  paths.add(path);
  const canonical = await realpath(path).catch(() => undefined);
  if (canonical) paths.add(canonical);
}

function ignoreMissing(error: NodeJS.ErrnoException) {
  if (error.code !== "ENOENT") throw error;
  return undefined;
}

export async function prepareMcpPrivateKeyRemoval(previous: string, next: string) {
  const directory = await realpath(previous).catch(ignoreMissing);
  if (!directory || !relative(directory, next)) return;
  const path = join(directory, privateKeyFile);
  const entry = await lstat(path, { bigint: true }).catch(ignoreMissing);
  if (!entry?.isFile() && !entry?.isSymbolicLink()) return;

  const [oldDirectory, newDirectory] = await Promise.all([
    stat(directory, { bigint: true }),
    stat(next, { bigint: true }),
  ]);
  if (oldDirectory.dev === newDirectory.dev && oldDirectory.ino === newDirectory.ino) return;

  const nextPath = join(next, privateKeyFile);
  async function checkNextKey(previousPath: string) {
    const [previousTarget, nextTarget] = await Promise.all([
      realpath(previousPath).catch(ignoreMissing),
      realpath(nextPath),
    ]);
    if (previousTarget && !relative(previousTarget, nextTarget))
      throw new Error("新旧证书目录引用了同一私钥，请为新目录提供独立的 device.key。");
  }
  await checkNextKey(path);

  return () =>
    withProjectDirectory(directory, [], async (root) => {
      const path = join(root, privateKeyFile);
      const current = await lstat(path, { bigint: true }).catch(ignoreMissing);
      if (!current) return;
      if (current.dev !== entry.dev || current.ino !== entry.ino)
        throw new Error("旧私钥已变化，无法删除。");
      await checkNextKey(path);
      await unlink(path).catch(ignoreMissing);
    });
}

type McpTlsDefinition = {
  id: string;
  name: string;
  label: string;
  description: string;
  url: string;
  openGetStream?: boolean;
  healthCheckPath?: string;
  requiredTools?: readonly string[];
};

type CertificateStatus = {
  state: "missing" | "ready" | "invalid";
  directory: string;
  message?: string;
};

async function readCredentials(directory: string) {
  if (!isAbsolute(directory)) throw new Error("证书目录必须是绝对路径。");
  async function readPem(name: string) {
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      return (await readBoundedFile(file, maxPemLength)).toString("utf8");
    } finally {
      await file.close();
    }
  }
  const [ca, cert, key] = await Promise.all([
    readPem("server-ca.crt"),
    readPem("device.crt"),
    readPem(privateKeyFile),
  ]);
  return { ca, cert, key };
}

function createConnection(
  definition: McpTlsDefinition,
  credentials: Awaited<ReturnType<typeof readCredentials>>,
) {
  let secureContext: ReturnType<typeof createSecureContext>;
  let deviceCertificate: X509Certificate;
  try {
    new X509Certificate(credentials.ca);
    deviceCertificate = new X509Certificate(credentials.cert);
    secureContext = createSecureContext(credentials);
  } catch {
    throw new Error("请检查 CA、客户端证书与私钥的 PEM 格式，并确认私钥与证书匹配。");
  }
  const validFrom = deviceCertificate.validFromDate.getTime();
  const validTo = deviceCertificate.validToDate.getTime();
  function checkValidity() {
    const now = Date.now();
    if (now < validFrom || now >= validTo) throw new Error("设备客户端证书不在有效期内。");
  }
  checkValidity();

  const url = new URL(definition.url);
  if (url.protocol !== "https:") throw new Error("使用 mTLS 的 MCP 服务必须使用 HTTPS。");
  const pool = new Pool(url.origin, {
    connect: { secureContext, rejectUnauthorized: true, timeout: 8_000 },
  });
  const request: McpFetch = (input, init) => {
    checkValidity();
    const target = new URL(input);
    if (target.origin !== url.origin || target.username || target.password)
      throw new Error("MCP 客户端证书只能用于已配置的服务地址。");
    const options = { ...init, dispatcher: pool, redirect: "error" as const };
    return fetch(target, options);
  };

  function createTransport(signal?: AbortSignal) {
    return new StreamableHttpTransport({
      url,
      openGetStream: definition.openGetStream ?? true,
      fetch: signal
        ? (input, init) =>
            request(input, {
              ...init,
              signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
            })
        : request,
    });
  }

  async function checkHealth(path: string, signal: AbortSignal) {
    let response: Response;
    try {
      response = await request(new URL(path, url), { signal });
      await response.body?.cancel();
    } catch (cause) {
      const error = cause instanceof Error ? (cause.cause ?? cause) : cause;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code && /CERT|SSL|TLS|ISSUER|VERIFY|SELF_SIGNED/u.test(code))
        throw new Error(`mTLS 握手失败，请检查 CA、设备证书和服务地址（${code}）。`);
      throw new Error("无法连接 MCP 服务，请检查网络连接和服务状态。");
    }
    if (!response.ok) throw new Error(`MCP 服务健康检查失败（HTTP ${response.status}）。`);
  }

  return {
    checkValidity,
    createTransport,
    close: () => pool.destroy(),
    async test() {
      const signal = AbortSignal.timeout(15_000);
      if (definition.healthCheckPath) await checkHealth(definition.healthCheckPath, signal);

      const client = new McpClient({ name: "dai-studio", version: "1", requestTimeoutMs: 5_000 });
      try {
        await client.connect(createTransport(signal));
        const tools = await client.listTools({ signal });
        const missing = definition.requiredTools?.filter(
          (name) => !tools.some((tool) => tool.name === name),
        );
        if (!missing?.length) return { tools: tools.length };
      } catch {
        throw new Error(`${definition.label}的 MCP 初始化或工具枚举失败。`);
      } finally {
        await client.close();
      }
      throw new Error("MCP 已连接，服务缺少配置中要求的工具。");
    },
  };
}

export function createMcpTlsService(definition: McpTlsDefinition, directory: string) {
  const entry: BuiltinMcpConnection["entry"] = {
    name: definition.name,
    source: definition.id,
    scope: "extension",
    config: { url: definition.url, description: definition.description },
  };
  let status: CertificateStatus = { state: "missing", directory };
  let active: { connection: ReturnType<typeof createConnection>; fingerprint: string } | undefined;

  function requireConnection() {
    if (!active) throw new Error(status.message ?? "请先在设备上配置 MCP 服务证书。");
    return active.connection;
  }

  return {
    entry,
    status: () => status,
    createTransport: () => requireConnection().createTransport(),
    async refresh(beforeReplace?: () => Promise<void>) {
      let next: typeof active;
      let nextStatus: CertificateStatus = { state: "ready", directory };
      try {
        const credentials = await readCredentials(directory);
        const fingerprint = createHash("sha256").update(JSON.stringify(credentials)).digest("hex");
        if (active?.fingerprint === fingerprint) {
          active.connection.checkValidity();
          return { status, connectionChanged: false };
        }
        next = { connection: createConnection(definition, credentials), fingerprint };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        nextStatus =
          code === "ENOENT"
            ? { state: "missing", directory }
            : {
                state: "invalid",
                directory,
                message:
                  code || !(error instanceof Error) ? "无法读取 MCP 证书文件。" : error.message,
              };
      }

      const connectionChanged = Boolean(active || next);
      if (connectionChanged && beforeReplace) {
        try {
          await beforeReplace();
        } catch (error) {
          await next?.connection.close();
          throw error;
        }
      }
      const previous = active;
      active = next;
      status = nextStatus;
      await previous?.connection.close();
      return { status, connectionChanged };
    },
    async test() {
      const active = requireConnection();
      active.checkValidity();
      return active.test();
    },
    close: () => active?.connection.close(),
  };
}
