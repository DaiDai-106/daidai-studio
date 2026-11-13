import { randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ApplicationEvent, ShellApproval } from "../../contracts/application.ts";

type Pending = {
  approval: ShellApproval;
  resolve(approved: boolean): void;
  signal?: AbortSignal;
  abort(): void;
};

/** 命令沿用桌面确认流程；多个会话的请求排队，取消只影响对应请求。 */
export function createShellApproval(publish: (event: ApplicationEvent) => void) {
  const queue: Pending[] = [];

  function current() {
    return queue[0]?.approval ?? null;
  }

  function changed() {
    publish({ type: "shell.approval", approval: current() });
  }

  function remove(item: Pending, result: boolean) {
    const index = queue.indexOf(item);
    if (index < 0) return;
    queue.splice(index, 1);
    item.signal?.removeEventListener("abort", item.abort);
    item.resolve(result);
    if (index === 0) changed();
  }

  function request(
    conversationId: string,
    command: string,
    cwd: string,
    shell: string,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const item: Pending = {
        approval: { id: randomUUID(), conversationId, command, cwd, shell },
        resolve,
        ...(signal ? { signal } : {}),
        abort: () => remove(item, false),
      };
      queue.push(item);
      signal?.addEventListener("abort", item.abort, { once: true });
      if (signal?.aborted) item.abort();
      else if (queue.length === 1) changed();
    });
  }

  return {
    pending: current,
    respond(id: string, approved: boolean) {
      const item = queue[0];
      if (!item || item.approval.id !== id) throw new Error("命令确认已失效。");
      remove(item, approved);
    },

    extension(conversationId: string, fullAccess?: () => boolean): ExtensionFactory {
      return (pi) => {
        pi.on("tool_call", async (event, context) => {
          if (event.toolName !== "bash" && event.toolName !== "powershell") return;
          const command = event.input.command;
          if (typeof command !== "string" || !command || command.length > 16000)
            return { block: true, reason: "命令为空或超过长度限制。" };
          if (fullAccess?.()) return;
          const approved = await request(
            conversationId,
            command,
            context.cwd,
            event.toolName,
            context.signal,
          );
          if (!approved)
            return {
              block: true,
              reason: context.signal?.aborted ? "命令已取消。" : "用户拒绝执行此命令。",
            };
        });
      };
    },

    close() {
      for (const item of [...queue]) remove(item, false);
    },
  };
}
