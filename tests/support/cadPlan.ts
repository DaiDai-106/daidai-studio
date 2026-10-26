import type { CadHandle } from "../../resources/mcp/cad/contract.ts";
import type { PlannerReply, PlannerRequest } from "./planner.ts";
import { turnResults } from "./planner.ts";

export function selectedStepPath(request: PlannerRequest): string {
  const context = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "")
    .join("\n")
    .split("<scene-context>\n")[1]
    ?.split("\n</scene-context>")[0];
  if (!context) throw new Error("Missing scene context");
  const { selectedSourcePath } = JSON.parse(context) as { selectedSourcePath: unknown };
  if (typeof selectedSourcePath !== "string") throw new Error("Missing selected STEP path");
  return selectedSourcePath;
}

// Four real function calls, driven by returned handles. The application does not
// run this sequence; this scripted model peer makes that separation testable.
export function planCadImport(request: PlannerRequest, quality = "preview"): PlannerReply | null {
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
