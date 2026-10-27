import { copyJson } from "@earendil-works/chord";
import { defineTool } from "@earendil-works/pi-durable";
import { type CallToolResult, type Tool, toLlmContent } from "@earendil-works/pi-mcp";
import type { PlacementChange } from "../../../resources/mcp/alignment/contract.ts";
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
  preparePlacement?(value: unknown): Promise<PlacementChange>;
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
        context.abortSignal?.throwIfAborted();
        let placement: PlacementChange | undefined;
        let placementError: { code: string; message: string } | undefined;
        if (!result.isError && result._meta?.["dai/placement"] !== undefined) {
          try {
            if (!options.preparePlacement) throw new Error("此连接不支持保存场景定位。");
            placement = await options.preparePlacement(result._meta["dai/placement"]);
          } catch {
            context.abortSignal?.throwIfAborted();
            placementError = {
              code: "PLACEMENT_PREPARE_FAILED",
              message:
                "定位计算已返回，但桌面未能接管定位结果，本次结果未发布，原有位置保持不变。请先读取当前场景状态，不要直接重复变换。",
            };
          }
        }
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
              message:
                "CAD 计算已返回，但桌面未能接管显示资源，本次结果未发布，原有显示保持不变。请先检查项目和保存状态，不要直接重复导入。",
            };
          }
        }
        context.abortSignal?.throwIfAborted();
        const handoffFailed = !!(placementError || displayError);
        return {
          output: [
            ...(placementError ? [{ type: "text" as const, text: placementError.message }] : []),
            ...(displayError ? [{ type: "text" as const, text: displayError.message }] : []),
            ...toLlmContent(result),
          ],
          isError: !!result.isError || handoffFailed,
          ...(display && !handoffFailed
            ? {
                diagnostics: [
                  {
                    severity: "info" as const,
                    code: "DESKTOP_DISPLAY_PREPARED",
                    message: `Desktop persistent display reference: ${JSON.stringify(display)}. Use the latest scene-context currentDisplay for placement and revision; do not reuse older importIds. CAD document/job handles and temporary file URIs are not display identities. This is not a renderer acknowledgement.`,
                  },
                ],
              }
            : {}),
          details: {
            ...identity,
            ...(placement && !handoffFailed ? { placement } : {}),
            ...(placementError ? { placementError } : {}),
            ...(result._meta ? { mcpMeta: copyJson(result._meta) } : {}),
            ...(display && !handoffFailed ? { display } : {}),
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
