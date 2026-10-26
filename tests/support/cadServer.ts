import { resolve } from "node:path";
import type { ServerConfig } from "../../resources/mcp/cad/types.ts";
import { openBuiltinMcp } from "../../src/backend/mcp/builtin.ts";

export function openCadServer(config: ServerConfig) {
  const { stagingRoot, ...options } = config;
  return openBuiltinMcp(resolve("resources/mcp/cad/server.ts"), options, stagingRoot);
}
