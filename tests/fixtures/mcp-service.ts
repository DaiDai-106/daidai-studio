import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// A non-CAD service: two discovery pages and ordinary text results.
export function createMcpFixture(
  onCall?: (name: string, args: Record<string, unknown>) => void | Promise<void>,
  definitions?: Tool[],
) {
  const server = new Server(
    { name: "generic-fixture", version: "1" },
    {
      capabilities: { tools: {} },
    },
  );
  const tools = definitions ?? [
    {
      name: "echo",
      inputSchema: {
        type: "object" as const,
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    { name: "status", inputSchema: { type: "object" as const, properties: {} } },
  ];
  server.setRequestHandler(ListToolsRequestSchema, (request) =>
    request.params?.cursor
      ? { tools: tools.slice(1) }
      : { tools: tools.slice(0, 1), nextCursor: "second" },
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    await onCall?.(request.params.name, request.params.arguments ?? {});
    return {
      content: [{ type: "text", text: String(request.params.arguments?.value ?? "ready") }],
    };
  });
  return { server, close: () => server.close() };
}
