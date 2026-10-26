import type { McpInspection } from "../../shared/capabilities.ts";
import type { Projects } from "../projects/handlers.ts";
import type { Settings } from "../settings/handlers.ts";
import type { Handlers } from "../types.ts";
import { inspectMcp, normalizeMcpConfig } from "./catalog.ts";

export function createMcpHandlers(
  settings: Settings,
  projects: Pick<Projects, "visible">,
  idle: () => void,
) {
  let inspection: { id: string; controller: AbortController; done: Promise<McpInspection> } | null =
    null;
  const handlers: Handlers<"mcp.save" | "mcp.remove" | "mcp.inspect" | "mcp.cancelInspect"> = {
    async "mcp.save"({ config }) {
      idle();
      const value = normalizeMcpConfig(config);
      if (value.scope.kind === "project") await projects.visible(value.scope.projectId);
      const previous = settings.read().mcpServers ?? [];
      if (!previous.some((server) => server.id === value.id) && previous.length >= 100)
        throw new Error("最多可配置 100 个 MCP 服务。");
      await settings.update((draft) => {
        draft.mcpServers = previous.some((server) => server.id === value.id)
          ? previous.map((server) => (server.id === value.id ? value : server))
          : [...previous, value];
      }, false);
      return value;
    },
    async "mcp.remove"({ id }) {
      idle();
      if (id.startsWith("builtin")) throw new Error("内置 MCP 服务只能停用。");
      await settings.update((draft) => {
        draft.mcpServers = (draft.mcpServers ?? []).filter((server) => server.id !== id);
      }, false);
      return null;
    },
    async "mcp.inspect"({ config, projectId }) {
      idle();
      const controller = new AbortController();
      const pending = {
        id: config.id,
        controller,
        done: Promise.resolve()
          .then(async () => {
            const project = await projects.visible(projectId);
            const signal = AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(config.timeoutMs),
            ]);
            return inspectMcp(config, project, signal);
          })
          .finally(() => {
            if (inspection === pending) inspection = null;
          }),
      };
      inspection = pending;
      return pending.done;
    },
    async "mcp.cancelInspect"({ id }) {
      const pending = inspection;
      if (pending?.id === id) {
        pending.controller.abort();
        await pending.done.catch(() => {});
      }
      return null;
    },
  };
  return {
    handlers,
    inspecting: () => inspection !== null,
    abort: () => inspection?.controller.abort(),
  };
}
