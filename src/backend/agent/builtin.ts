import { defineExtension, section } from "@earendil-works/pi-durable";
import type { Artifacts } from "../artifacts/store.ts";
import type { Builtins } from "../builtin.ts";
import { authorizeStepPath } from "../projects/files.ts";
import { registerMcpTool } from "./mcpTool.ts";
import type { RunContext } from "./types.ts";

export function createBuiltinAgent(
  builtins: Builtins,
  target: () => RunContext,
  artifacts: Artifacts,
) {
  const cad = builtins.cad;
  const tools = cad.tools.map((tool) =>
    registerMcpTool({
      name: tool.name,
      serverName: cad.descriptor.name,
      tool,
      async prepareDisplay(artifact, signal) {
        const run = target();
        const connection = await cad.open(run.project, signal);
        return artifacts.prepare(artifact, connection, run, signal);
      },
      target(id) {
        if (target().conversationId !== id) throw new Error("此工具没有有效的本轮目标。");
      },
      async invoke(args, context) {
        try {
          const run = target();
          if (tool.name === "cad_import_step")
            await authorizeStepPath(run.project.path, run.source, args.path, context.signal);
          const connection = await cad.open(run.project, context.signal);
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
  );
  return {
    extension: defineExtension({
      name: "step-import",
      tools,
      sections: [
        section("scene-building", () => target().skill ?? undefined),
        section("scene-context", () => {
          const run = target();
          return JSON.stringify({
            selectedSourcePath: run.source?.path ?? null,
            currentFileHash: run.source?.sha256 ?? null,
          });
        }),
      ],
    }),
    tools(enabled: (id: string) => boolean) {
      return cad.available && enabled(cad.descriptor.id) ? tools : [];
    },
  };
}
