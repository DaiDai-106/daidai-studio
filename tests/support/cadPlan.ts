import type { CadHandle } from "../../resources/mcp/cad/contract.ts";
import type { SceneContext } from "../../src/backend/agent/types.ts";
import type { PlannerReply, PlannerRequest } from "./planner.ts";
import { turnResults } from "./planner.ts";

export function sceneContext(request: PlannerRequest) {
  const raw = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "")
    .join("\n")
    .split("<scene-context>\n")
    .at(-1)
    ?.split("\n</scene-context>")[0];
  if (!raw) throw new Error("Missing scene context");
  return JSON.parse(raw) as SceneContext;
}
export function selectedStepPath(request: PlannerRequest): string {
  const path = sceneContext(request).selectedSourcePath;
  if (typeof path !== "string") throw new Error("Missing selected STEP path");
  return path;
}
export function currentDisplayId(request: PlannerRequest): string | null {
  const value = sceneContext(request).currentDisplay?.importId;
  return typeof value === "string" ? value : null;
}

// Four real function calls, driven by returned handles. The application does not
// run this sequence; this scripted model peer makes that separation testable.
export function planCadImport(
  request: PlannerRequest,
  quality = "preview",
  features = false,
): PlannerReply | null {
  const results = turnResults(request);
  if (!results.has("cad-import"))
    return { id: "cad-import", name: "cad_import_step", args: { path: selectedStepPath(request) } };
  if (!results.has("cad-import-wait"))
    return {
      id: "cad-import-wait",
      name: "cad_wait_job",
      args: { job: results.read<{ data: { job: CadHandle } }>("cad-import").data.job },
    };
  if (!results.has("cad-display"))
    return {
      id: "cad-display",
      name: "cad_build_display",
      args: {
        document: results.read<{ data: { result: { document: CadHandle } } }>("cad-import-wait")
          .data.result.document,
        quality,
        ...(features ? { features: "alignment" } : {}),
      },
    };
  if (!results.has("cad-display-wait"))
    return {
      id: "cad-display-wait",
      name: "cad_wait_job",
      args: { job: results.read<{ data: { job: CadHandle } }>("cad-display").data.job },
    };
  return null;
}
