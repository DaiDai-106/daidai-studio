import { copyJson } from "@earendil-works/chord";
import { defineTool } from "@earendil-works/pi-durable";
import { type CallToolResult, type Tool, toLlmContent } from "@earendil-works/pi-mcp";
import type { ImportedModelRef } from "../../shared/display.ts";
import type { ToolInvocation } from "../mcp/types.ts";

// Built-in and configured services share this durable execution boundary.
// The service owns the operation; the model chooses the next tool.
export function registerMcpTool(options: {
  name: string;
  serverName: string;
  tool: Tool;
  deferred?: boolean;
  target(conversationId: string): void;
  invoke(args: Record<string, unknown>, invocation: ToolInvocation): Promise<CallToolResult>;
  prepareDisplay?(artifact: unknown, signal: AbortSignal): Promise<ImportedModelRef>;
  failed?(): Promise<void>;
}) {
  const { tool } = options;
  return defineTool({
    name: options.name,
    description: `[${options.serverName}] ${tool.description ?? tool.name}`.slice(0, 8000),
    parameters: tool.inputSchema,
    ...(options.deferred ? { deferred: true } : {}),
    replay: "unsafe",
    outputLimits: { maxBytes: 64000, maxLines: 500 },
    async execute(args, api, context) {
      options.target(String(api.conversationId));
      const identity = { serverName: options.serverName, toolName: tool.name };
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("MCP 参数必须是对象。");
      try {
        await api.details(identity, context);
        const result = await options.invoke(
          { ...args },
          {
            signal: context.abortSignal ?? AbortSignal.timeout(300_000),
            progress: async (phase) => {
              await api.details({ ...identity, phase: phase.slice(0, 200) }, context);
            },
          },
        );
        let display: ImportedModelRef | undefined;
        let displayError: { code: string; message: string } | undefined;
        const artifact = result._meta?.["dai/display"];
        if (!result.isError && artifact !== undefined) {
          try {
            if (!options.prepareDisplay) throw new Error("此连接尚不支持接管显示资源。");
            display = await options.prepareDisplay(
              artifact,
              context.abortSignal ?? AbortSignal.timeout(300_000),
            );
          } catch {
            context.abortSignal?.throwIfAborted();
            displayError = {
              code: "DISPLAY_PREPARE_FAILED",
              message: "CAD 计算已返回，但显示资源保存失败，保留上次显示。",
            };
          }
        }
        return {
          output: [
            ...toLlmContent(result),
            ...(displayError ? [{ type: "text" as const, text: displayError.message }] : []),
          ],
          isError: !!result.isError,
          details: {
            ...identity,
            ...(result._meta ? { mcpMeta: copyJson(result._meta) } : {}),
            ...(display ? { display } : {}),
            ...(displayError ? { displayError } : {}),
          },
        };
      } catch {
        await options.failed?.();
        context.abortSignal?.throwIfAborted();
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: "MCP 服务调用未成功，请检查配置或重新发送请求。连接中断不代表远端操作已撤销。",
            },
          ],
          details: identity,
        };
      }
    },
  });
}
