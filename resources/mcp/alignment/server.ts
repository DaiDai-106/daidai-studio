import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Value } from "typebox/value";
import { AlignmentConfigSchema, createAlignmentServer } from "./service.ts";

const path = process.argv[2];
if (!path) throw new Error("Usage: alignment-mcp <config.json>");
const config: unknown = JSON.parse(await readFile(path, "utf8"));
if (
  !Value.Check(AlignmentConfigSchema, config) ||
  !isAbsolute(config.stagingRoot) ||
  (config.executable && !isAbsolute(config.executable)) ||
  (config.projectRoot && !isAbsolute(config.projectRoot)) ||
  (config.sceneRoot && !isAbsolute(config.sceneRoot))
)
  throw new Error("Invalid alignment configuration.");
const service = createAlignmentServer(config);
function close() {
  void service.close().catch(() => {
    console.error("Alignment shutdown failed.");
    process.exitCode = 1;
  });
}
process.stdin.once("end", close);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, close);
await service.server.connect(new StdioServerTransport());
