import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";
import {
  CaptureInputSchema,
  captureRequestMethod,
  ViewportCaptureSchema,
  viewportTools,
} from "./contract.ts";

const server = new Server(
  { name: "viewport-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: viewportTools }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const args = request.params.arguments ?? {};
  if (request.params.name !== "viewport_capture" || !Value.Check(CaptureInputSchema, args))
    throw new McpError(ErrorCode.InvalidParams, "Invalid viewport capture arguments.");
  try {
    // The desktop owns the renderer; this namespaced MCP request is its host capability.
    const result = await server.request(
      { method: captureRequestMethod, params: args },
      ResultSchema,
      { signal: extra.signal, timeout: 15_000 },
    );
    if (!Value.Check(ViewportCaptureSchema, result.capture)) throw new Error("当前视口不可用。");
    const { image, camera, views } = result.capture;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ...args,
            view: args.view ?? "current",
            ...(views ? { views } : { camera }),
          }),
        },
        { type: "image" as const, ...image },
      ],
    };
  } catch (error) {
    extra.signal.throwIfAborted();
    return {
      isError: true,
      content: [
        { type: "text" as const, text: error instanceof Error ? error.message : "视口截图失败。" },
      ],
    };
  }
});
await server.connect(new StdioServerTransport());
process.stdin.once("end", () => void server.close());
