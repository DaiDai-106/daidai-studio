import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Artifacts } from "../artifacts/store.ts";
import type { Placements } from "../projects/placements.ts";
import { registerMcpTool } from "./mcpTool.ts";
import { getSceneContext } from "./scene.ts";
import type { RunContext } from "./types.ts";

const inputSchema = Type.Object(
  {
    importId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

// Desktop owns the journal. A successful result goes through the ordinary durable placement handoff.
export function createPlacementUndo(
  target: () => RunContext,
  artifacts: Artifacts,
  placements: Placements,
) {
  const name = "scene_undo_placement";
  return registerMcpTool({
    name,
    serverName: "desktop-scene",
    tool: {
      name,
      description:
        "Undo the latest saved placement for the current assembly only when the user explicitly requests undo. Restores the previous absolute pose as a new revision. Undoing again reverses that undo, not an earlier history step. Requires the latest importId and expectedRevision; never blindly retry a conflict.",
      inputSchema: { ...inputSchema, type: "object" },
    },
    target(id) {
      if (target().conversationId !== id) throw new Error("此工具没有有效的本轮目标。");
    },
    preparePlacement: (value) => placements.prepare(value, target()),
    async invoke(args) {
      const fail = (code: string, message: string) => {
        const result = { ok: false, error: { code, message } };
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      };
      if (!Value.Check(inputSchema, args)) return fail("INVALID_ARGUMENT", "撤销参数无效。");
      const run = target();
      const scene = await getSceneContext(run, artifacts, placements);
      const current = scene.currentDisplay;
      if (!current || current.importId !== args.importId)
        return fail("SCENE_TARGET_CHANGED", "当前显示模型已变化，请重新读取场景状态。");
      if (current.placement.revision !== args.expectedRevision)
        return fail("REVISION_CONFLICT", "定位版本已变化，请重新读取场景状态。");
      try {
        const result = await placements.undo(args.importId, args.expectedRevision, run);
        const data = {
          ok: true,
          data: {
            importId: args.importId,
            baseRevision: args.expectedRevision,
            restoredRevision: result.previousRevision,
            before: {
              translation: current.placement.translation,
              rotation: current.placement.rotation,
            },
            after: { translation: result.change.translation, rotation: result.change.rotation },
          },
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          structuredContent: data,
          _meta: { "dai/placement": result.change },
        };
      } catch (error) {
        return fail("UNDO_UNAVAILABLE", error instanceof Error ? error.message : "无法撤销定位。");
      }
    },
  });
}
