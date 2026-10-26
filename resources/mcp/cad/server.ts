import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Value } from "typebox/value";
import { createCadServer } from "./service.ts";
import { ServerConfigSchema } from "./types.ts";

const path = process.argv[2];
if (!path) throw new Error("Usage: cad-mcp <config.json>");
const config: unknown = JSON.parse(await readFile(path, "utf8"));
if (
  !Value.Check(ServerConfigSchema, config) ||
  !isAbsolute(config.stagingRoot) ||
  (config.executable && !isAbsolute(config.executable)) ||
  (config.projectRoot && !isAbsolute(config.projectRoot))
)
  throw new Error("Invalid CAD MCP configuration.");
await mkdir(config.stagingRoot, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(config.stagingRoot, "cad-service-"));
const cad = createCadServer(config, directory);
let closing: Promise<void> | undefined;
function close() {
  closing ??= Promise.resolve().then(async () => {
    try {
      await cad.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  void closing.catch(() => {
    console.error("CAD shutdown failed; private outputs may remain.");
    process.exitCode = 1;
  });
}
process.stdin.once("end", close);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, close);
try {
  await cad.server.connect(new StdioServerTransport());
} catch (error) {
  close();
  await closing;
  throw error;
}
