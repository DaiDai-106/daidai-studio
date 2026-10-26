import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCadServer } from "../../resources/mcp/cad/service.ts";
import type { ServerConfig } from "../../resources/mcp/cad/types.ts";

const config = JSON.parse(await readFile(process.argv[2] ?? "", "utf8")) as ServerConfig;
await mkdir(config.stagingRoot, { recursive: true });
const root = await mkdtemp(join(config.stagingRoot, "acceptance-"));
const cad = createCadServer(config, root);
const transport = new StdioServerTransport();
const send = transport.send.bind(transport);
let delayed = false;
// Delay only delivery of the accepted job, after the production service has computed it.
transport.send = async (message) => {
  if (!delayed && "result" in message && "structuredContent" in message.result) {
    const result = message.result.structuredContent;
    if (
      result &&
      typeof result === "object" &&
      "data" in result &&
      result.data &&
      typeof result.data === "object" &&
      "job" in result.data
    ) {
      delayed = true;
      await writeFile(process.argv[3] ?? "", "accepted");
      await setTimeout(1000);
    }
  }
  await send(message);
};
let closing: Promise<void> | undefined;
function close() {
  closing ??= Promise.resolve().then(async () => {
    try {
      await cad.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  void closing.catch(() => {
    process.exitCode = 1;
  });
}
process.stdin.once("end", close);
process.once("SIGTERM", close);
await cad.server.connect(transport);
