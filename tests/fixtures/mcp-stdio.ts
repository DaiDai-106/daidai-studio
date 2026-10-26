import { appendFile, writeFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpFixture } from "./mcp-service.ts";

const marker = process.argv[2];
if (!marker) throw new Error("Exit marker required.");
const exitMarker = marker;
const calls = process.argv[3];
const service = createMcpFixture(
  calls ? (name, args) => appendFile(calls, `${JSON.stringify({ name, args })}\n`) : undefined,
);
let closing: Promise<void> | undefined;
function close() {
  closing ??= service.close().then(() => writeFile(exitMarker, "closed"));
  void closing.catch(() => {
    process.exitCode = 1;
  });
}
process.stdin.once("end", close);
process.once("SIGTERM", close);
await service.server.connect(new StdioServerTransport());
