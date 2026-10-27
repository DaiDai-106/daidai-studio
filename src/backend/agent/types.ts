import type { Placement } from "../../../resources/mcp/alignment/contract.ts";
import type { CatalogPage } from "../artifacts/types.ts";
import type { createMcpRun } from "./mcp.ts";

// Immutable desktop authorization target, separate from CAD service data.
export interface RunContext {
  readonly conversationId: string;
  readonly project: { readonly id: string; readonly path: string };
  // Source identity survives missing/changed files; source below is only the readable import snapshot.
  sourceId: string | null;
  selectedSourcePath: string | null;
  sceneProfileId?: string | null;
  sceneProfileScope?: "project" | "source" | null;
  sceneProfileSkillAvailable?: boolean;
  readonly sceneSkills?: import("../../../resources/mcp/scene-profiles/catalog.ts").SceneSkill[];
  source: {
    readonly id: string;
    readonly path: string;
    readonly relativePath: string;
    readonly sha256: string;
  } | null;
  // Built-in mode instructions, separate from selected custom skills.
  readonly skill: string | null;
}

// One desktop-owned run. Object identity also guards delayed completion callbacks.
export interface ActiveRun {
  readonly conversationId: string;
  readonly scene: boolean;
  // Frozen scene target; ordinary chat has no CAD authorization context.
  context: RunContext | null;
  skillBody: string | null;
  baseSkillBody: string | null;
  // External MCP connections owned by this run; built-ins have their own lifecycle.
  mcp: ReturnType<typeof createMcpRun>;
}

// The current desktop target, shared by prompt sections and recoverable authorization errors.
export interface SceneContext {
  sceneProfileId: string | null;
  sceneProfileScope: "project" | "source" | null;
  sceneProfileSkillAvailable: boolean;
  currentDisplay: {
    importId: string;
    sourceHash: string;
    importFingerprint: string;
    placement: Placement;
  } | null;
  files: {
    manifest: string;
    objects: CatalogPage[];
    references: CatalogPage[];
    features: string | null;
    placement: string | null;
    catalogError: { code: string; message: string } | null;
  } | null;
  sourceStatus: "current" | "changed" | "missing" | "unselected";
  selectedSourcePath: string | null;
  currentFileHash: string | null;
}

// Provider call IDs can repeat; the entry-qualified key identifies a displayed tool call.
export interface ProjectedToolCall {
  args: Record<string, unknown>;
  key: string;
}
