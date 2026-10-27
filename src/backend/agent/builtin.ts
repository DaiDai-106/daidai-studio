import { defineExtension, section } from "@earendil-works/pi-durable";
import type { ApplicationEvent } from "../../shared/application.ts";
import type { Artifacts } from "../artifacts/store.ts";
import type { Builtins } from "../builtin.ts";
import { authorizeStepPath } from "../projects/files.ts";
import type { Placements } from "../projects/placements.ts";
import { registerMcpTool } from "./mcpTool.ts";
import { createSceneReadTool } from "./read.ts";
import { getSceneContext, sceneFailure } from "./scene.ts";
import { createShell } from "./shell.ts";
import type { RunContext } from "./types.ts";

export function createBuiltinAgent(
  builtins: Builtins,
  target: () => RunContext,
  artifacts: Artifacts,
  placements: Placements,
  publish: (event: ApplicationEvent) => void,
) {
  const tools = builtins.services.flatMap((service) =>
    service.tools.map((tool) =>
      registerMcpTool({
        name: tool.name,
        serverName: service.descriptor.name,
        tool,
        async prepareDisplay(artifact, signal) {
          const run = target();
          const connection = await service.open(
            { ...run.project, sceneRoot: await artifacts.directory(run.project.id) },
            signal,
          );
          return artifacts.prepare(artifact, connection, run, signal);
        },
        preparePlacement: (value) => placements.prepare(value, target()),
        target(id) {
          if (target().conversationId !== id) throw new Error("此工具没有有效的本轮目标。");
        },
        async invoke(args, context) {
          try {
            const run = target();
            if (service.descriptor.id === "builtin.alignment") {
              const scene = await getSceneContext(run, artifacts, placements);
              if (!scene.currentDisplay || scene.currentDisplay.importId !== args.importId) {
                const result = sceneFailure(
                  scene.currentDisplay ? "SCENE_TARGET_CHANGED" : "NO_CURRENT_DISPLAY",
                  scene.currentDisplay
                    ? "请求使用了历史 importId；当前模型已经发布。请使用 scene.currentDisplay 的 importId 和 revision，不要重新导入，也不要自动重试旧参数。"
                    : "当前所选来源没有已发布模型，请核对 STEP 关联后再决定是否导入。",
                  scene,
                );
                return {
                  isError: true,
                  content: [{ type: "text", text: JSON.stringify(result) }],
                  structuredContent: result,
                };
              }
            }
            if (tool.name === "cad_import_step")
              await authorizeStepPath(run.project.path, run.source, args.path, context.signal);
            const connection = await service.open(
              { ...run.project, sceneRoot: await artifacts.directory(run.project.id) },
              context.signal,
            );
            return await connection.client.callTool(tool.name, args, {
              signal: context.signal,
              timeoutMs: 300_000,
              onProgress: (value) => {
                if (value.message) void context.progress(value.message).catch(() => {});
              },
            });
          } catch (error) {
            context.signal.throwIfAborted();
            return {
              content: [
                { type: "text", text: error instanceof Error ? error.message : "CAD 调用失败。" },
              ],
              isError: true,
            };
          }
        },
      }),
    ),
  );
  const read = createSceneReadTool(target, artifacts, placements);
  const shell = createShell(target, publish);
  return {
    shell,
    extension: defineExtension({
      name: "step-import",
      tools: [...tools, read, shell.tool],
      sections: [
        section("scene-building", () => target().skill ?? undefined),
        section("scene-context", async () => {
          return JSON.stringify(await getSceneContext(target(), artifacts, placements));
        }),
      ],
    }),
    tools(enabled: (id: string) => boolean) {
      const names = new Set(
        builtins.services
          .filter((service) => service.available && enabled(service.descriptor.id))
          .flatMap((service) => service.tools.map((tool) => tool.name)),
      );
      return [...tools.filter((tool) => names.has(tool.name)), read, shell.tool];
    },
  };
}
