import type { createMcpRun } from "./mcp.ts";

// Immutable desktop authorization target, separate from CAD service data.
export interface RunContext {
  readonly conversationId: string;
  readonly project: { readonly id: string; readonly path: string };
  readonly source: {
    readonly id: string;
    readonly path: string;
    readonly relativePath: string;
    readonly sha256: string;
  } | null;
  // Built-in STEP import instructions, separate from selected custom skills.
  readonly skill: string | null;
}

// One desktop-owned run. Object identity also guards delayed completion callbacks.
export interface ActiveRun {
  readonly conversationId: string;
  readonly scene: boolean;
  // Frozen scene target; ordinary chat has no CAD authorization context.
  context: RunContext | null;
  skillBody: string | null;
  // External MCP connections owned by this run; built-ins have their own lifecycle.
  mcp: ReturnType<typeof createMcpRun>;
}
