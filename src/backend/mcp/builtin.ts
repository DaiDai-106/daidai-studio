import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuiltinCatalog } from "../../shared/capabilities.ts";
import { discoverMcpTools } from "./catalog.ts";
import { openMcpConnection } from "./connection.ts";
import type { BuiltinMcpDefinition } from "./types.ts";

// A bundled service is an ordinary stdio endpoint with a private launch-config file.
export async function openBuiltinMcp(
  serverPath: string,
  config: object,
  temporaryRoot: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(temporaryRoot, "mcp-"));
  let connection: Awaited<ReturnType<typeof openMcpConnection>> | undefined;
  let closing: Promise<void> | undefined;
  function close() {
    closing ??= Promise.resolve().then(async () => {
      try {
        await connection?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    return closing;
  }
  try {
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({ ...config, stagingRoot: root }), { mode: 0o600 });
    connection = await openMcpConnection(
      {
        kind: "stdio",
        options: {
          command: process.execPath,
          args: ["--experimental-strip-types", serverPath, path],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          closeTimeoutMs: 7000,
        },
      },
      signal ? { signal } : {},
    );
    const tools = await discoverMcpTools(connection, 30_000, signal ?? AbortSignal.timeout(30_000));
    return { client: connection.client, tools, root, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// One lifecycle for any bundled stdio plugin. Project scope is trusted launch data.
export async function loadBuiltinMcp(definition: BuiltinMcpDefinition, temporaryRoot: string) {
  const discovered = await openBuiltinMcp(
    definition.serverPath,
    definition.configuration,
    temporaryRoot,
  );
  const tools = discovered.tools;
  await discovered.close();
  let active: ReturnType<typeof openBuiltinMcp> | undefined;
  let projectPath: string | undefined;
  let closing = Promise.resolve();
  async function release() {
    const previous = active;
    active = undefined;
    projectPath = undefined;
    closing = closing.then(async () => {
      await previous?.then(
        (value) => value.close(),
        () => undefined,
      );
    });
    await closing;
  }
  return {
    available: definition.available,
    tools,
    descriptor: {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      modes: definition.modes,
      available: definition.available,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: (
          definition.toolDescriptions?.[tool.name] ??
          tool.description ??
          tool.name
        ).slice(0, 1000),
      })),
    } satisfies BuiltinCatalog["servers"][number],
    release,
    close: release,
    async open(project: { path: string }, signal?: AbortSignal) {
      if (!definition.available)
        throw new Error(`${definition.name} 原生程序尚未安装，请先构建对应模块。`);
      signal?.throwIfAborted();
      if (active && projectPath === project.path) return active;
      await release();
      if (!active) {
        projectPath = project.path;
        active = openBuiltinMcp(
          definition.serverPath,
          { ...definition.configuration, projectRoot: project.path },
          temporaryRoot,
          signal,
        );
      }
      if (projectPath !== project.path)
        throw new Error("MCP 服务仍属于其他项目，请先结束本轮调用。");
      return active;
    },
  };
}
