import type { CallToolResult } from "@earendil-works/pi-mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export interface ToolContext {
  signal: AbortSignal;
  progress(phase: string): Promise<void>;
}
export interface McpTool {
  name: string;
  description: string;
  parameters: TSchema;
  readOnly: boolean;
  invoke(args: unknown, context: ToolContext): Promise<CallToolResult>;
}
export function defineMcpTool<T extends TSchema>(options: {
  name: string;
  description: string;
  parameters: T;
  readOnly?: boolean;
  execute(args: Static<T>, context: ToolContext): Promise<CallToolResult>;
}): McpTool {
  return {
    ...options,
    readOnly: options.readOnly ?? false,
    async invoke(args, context) {
      if (!Value.Check(options.parameters, args))
        throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${options.name}.`);
      context.signal.throwIfAborted();
      return options.execute(args, context);
    },
  };
}
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) ?? "null" }] };
}

// Official SDK owns the MCP protocol. Domain tools know nothing about durable.
export function createToolServer(
  name: string,
  tools: readonly McpTool[],
  onError: (error: unknown) => CallToolResult,
) {
  const server = new Server({ name, version: "0.1.0" }, { capabilities: { tools: {} } });
  const active = new Set<Promise<CallToolResult>>();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  if (byName.size !== tools.length) throw new Error("Duplicate builtin MCP tool name.");
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { ...tool.parameters, type: "object" as const },
      annotations: { readOnlyHint: tool.readOnly },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, "Unknown builtin tool.");
    const work = Promise.resolve().then(async () => {
      try {
        return await tool.invoke(request.params.arguments ?? {}, {
          signal: extra.signal,
          progress: async (message) => {
            const token = request.params._meta?.progressToken;
            if (token !== undefined)
              await extra.sendNotification({
                method: "notifications/progress",
                params: { progressToken: token, progress: 0, message },
              });
          },
        });
      } catch (error) {
        extra.signal.throwIfAborted();
        return onError(error);
      }
    });
    active.add(work);
    try {
      return await work;
    } finally {
      active.delete(work);
    }
  });
  async function idle() {
    await Promise.allSettled([...active]);
  }
  return {
    server,
    idle,
    async close() {
      try {
        await server.close();
      } finally {
        await idle();
      }
    },
  };
}
