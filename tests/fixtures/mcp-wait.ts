import { writeFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ready = process.argv[2] ?? "";
const ended = process.argv[3] ?? "";
const server = new Server(
  { name: "stdio-cancellation", version: "1" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: "wait", inputSchema: { type: "object" as const } }],
}));
let pending: Promise<void> = Promise.resolve();
server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
  pending = (async () => {
    await writeFile(ready, "ready");
    await new Promise<void>((resolve) => {
      if (extra.signal.aborted) resolve();
      else extra.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await writeFile(ended, "stopped");
  })();
  await pending;
  return { content: [{ type: "text", text: "Stopped." }] };
});
let closing: Promise<void> | undefined;
function close() {
  closing ??= Promise.resolve().then(async () => {
    await server.close();
    await pending;
  });
  void closing.catch(() => {
    process.exitCode = 1;
  });
}
process.stdin.once("end", close);
process.once("SIGTERM", close);
await server.connect(new StdioServerTransport());
