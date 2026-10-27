import { randomUUID } from "node:crypto";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool, createPowerShellTool } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import type { ApplicationEvent, ShellApproval } from "../../shared/application.ts";
import type { RunContext } from "./types.ts";

// Shell commands cannot be reliably classified as read-only, so every command requires approval.
export function createShell(target: () => RunContext, publish: (event: ApplicationEvent) => void) {
  let pending: { approval: ShellApproval; resolve: (approved: boolean) => void } | undefined;
  const native = process.platform === "win32" ? createPowerShellTool() : createBashTool();
  function respond(id: string, approved: boolean) {
    if (!pending || pending.approval.id !== id) throw new Error("命令确认已失效。");
    pending.resolve(approved);
  }
  const tool = {
    ...native,
    replay: "unsafe" as const,
    description: `${native.description} Commands run with the local user's permissions; each command requires explicit user approval. Prefer read and CAD tools for scene inspection.`,
    parameters: Type.Object({
      command: Type.String({
        minLength: 1,
        maxLength: 16000,
        description: "Command to execute after user approval",
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
    }),
    async execute(
      args: Parameters<typeof native.execute>[0],
      api: Parameters<typeof native.execute>[1],
      context: Parameters<typeof native.execute>[2],
    ) {
      const run = target();
      if (String(api.conversationId) !== run.conversationId)
        throw new Error("命令没有有效的本轮目标。");
      if (pending) throw new Error("已有命令等待确认。");
      context.abortSignal?.throwIfAborted();
      const approval: ShellApproval = {
        id: randomUUID(),
        conversationId: run.conversationId,
        command: args.command,
        cwd: run.project.path,
        shell: native.name,
      };
      const approved = await new Promise<boolean>((resolve, reject) => {
        const abort = () => {
          clear();
          reject(context.abortSignal?.reason ?? new Error("命令已取消。"));
        };
        const clear = () => {
          context.abortSignal?.removeEventListener("abort", abort);
          pending = undefined;
          publish({ type: "shell.approval", approval: null });
        };
        pending = {
          approval,
          resolve: (decision) => {
            clear();
            resolve(decision);
          },
        };
        context.abortSignal?.addEventListener("abort", abort, { once: true });
        if (context.abortSignal?.aborted) abort();
        else publish({ type: "shell.approval", approval });
      });
      if (!approved) throw new Error("用户拒绝执行此命令。");
      context.abortSignal?.throwIfAborted();
      const env = new NodeExecutionEnv({ cwd: run.project.path });
      try {
        return await native.execute(args, { ...api, env }, context);
      } finally {
        await env.cleanup(context);
      }
    },
  };
  return { tool, respond, pending: () => pending?.approval ?? null };
}
