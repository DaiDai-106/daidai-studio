import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  AlignmentNativeResultSchema,
  alignmentTools,
  type Placement,
  PlacementChangeSchema,
  validRotation,
} from "./contract.ts";

export const AlignmentConfigSchema = Type.Object(
  {
    stagingRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    executable: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    projectRoot: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    sceneRoot: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  { additionalProperties: false },
);
export type AlignmentConfig = Static<typeof AlignmentConfigSchema>;

import { loadSavedModel, readPlacement } from "./files.ts";

const nativeEnvelope = Type.Union([
  Type.Object(
    { ok: Type.Literal(true), data: AlignmentNativeResultSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ok: Type.Literal(false),
      error: Type.Object(
        { code: Type.String(), message: Type.String() },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);
function failure(code: string, message: string, currentPlacement?: Placement) {
  const result = {
    ok: false,
    error: { code, message },
    ...(currentPlacement ? { currentPlacement } : {}),
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

export function createAlignmentServer(config: AlignmentConfig) {
  const server = new Server(
    { name: "alignment-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  const children = new Set<ChildProcess>();
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;

  async function executeNative(input: object, signal: AbortSignal) {
    signal.throwIfAborted();
    const executable = config.executable;
    if (!executable || !isAbsolute(executable) || closing)
      throw new Error("Alignment worker is unavailable.");
    const task = new Promise<unknown>((resolve, reject) => {
      const child = spawn(executable, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      children.add(child);
      let output = "";
      let failure: Error | undefined;
      const abort = () => {
        child.kill();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.on("error", (error) => {
        failure = error;
      });
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output) > 64_000) {
          failure = new Error("Native output limit exceeded.");
          child.kill();
        }
      });
      child.stderr.resume();
      // Resolve cancellation only after close; an abort event alone does not prove process exit.
      child.once("close", (code) => {
        children.delete(child);
        signal.removeEventListener("abort", abort);
        if (signal.aborted || failure || code !== 0)
          reject(failure ?? new Error("Alignment computation stopped or failed."));
        else {
          try {
            resolve(JSON.parse(output));
          } catch {
            reject(new Error("Invalid native alignment response."));
          }
        }
      });
      child.stdin.end(`${JSON.stringify(input)}\n`);
    });
    pending.add(task);
    try {
      return await task;
    } finally {
      pending.delete(task);
    }
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: alignmentTools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = alignmentTools.find((item) => item.name === request.params.name);
    const args = request.params.arguments ?? {};
    if (!tool || !Value.Check(tool.inputSchema, args))
      throw new McpError(ErrorCode.InvalidParams, "Invalid alignment tool or arguments.");
    const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(120_000)]);
    try {
      if (!config.sceneRoot || !isAbsolute(config.sceneRoot))
        throw new Error("No authorized project.");
      const { importId } = args;
      const saved = await loadSavedModel(config.sceneRoot, importId, signal);
      const placement = await readPlacement(
        config.sceneRoot,
        importId,
        saved.manifest.source.sourceHash,
      );
      if (
        "expectedRevision" in args &&
        args.expectedRevision !== undefined &&
        args.expectedRevision !== placement.revision
      )
        return failure(
          "REVISION_CONFLICT",
          "Placement changed; reconsider the operation using currentPlacement and the latest scene context. Do not blindly replay a relative rotation.",
          placement,
        );
      const response = await executeNative(
        {
          glbPath: saved.glbPath,
          manifestPath: saved.manifestPath,
          ...(saved.featuresPath ? { featuresPath: saved.featuresPath } : {}),
          displayToScene: saved.manifest.displayToScene,
          placement: { translation: placement.translation, rotation: placement.rotation },
          operation: tool.name,
          arguments: args,
        },
        signal,
      );
      if (!Value.Check(nativeEnvelope, response))
        throw new Error("Invalid native alignment response.");
      if (!response.ok) return failure(response.error.code, response.error.message);
      const result = response.data;
      if (!validRotation(result.after.placement.rotation))
        throw new Error("Invalid native rotation.");
      const query = tool.name === "alignment_get_bounds";
      const data = {
        importId,
        sourceHash: placement.sourceHash,
        unit: "m",
        boundsKind: "display-mesh",
        warnings: saved.manifest.complete
          ? []
          : ["Bounds cover rendered triangles; some original CAD faces are not displayed."],
        ...(query
          ? {
              revision: placement.revision,
              space: "world",
              ...("objectId" in args ? { objectId: args.objectId } : {}),
              placement: result.before.placement,
              bounds: result.before.bounds,
            }
          : { baseRevision: placement.revision, ...result }),
      };
      const change = {
        schemaVersion: 2 as const,
        importId,
        sourceHash: placement.sourceHash,
        expectedRevision: placement.revision,
        ...result.after.placement,
      };
      if (!Value.Check(PlacementChangeSchema, change))
        throw new Error("Invalid placement proposal.");
      const envelope = { ok: true, data };
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
        ...(!query ? { _meta: { "dai/placement": change } } : {}),
      };
    } catch (error) {
      signal.throwIfAborted();
      return failure(
        "INVALID_RESOURCE",
        error instanceof Error ? error.message : "Alignment failed.",
      );
    }
  });
  return {
    server,
    close() {
      closing ??= (async () => {
        for (const child of children) child.kill();
        await Promise.allSettled([...pending]);
        await server.close();
      })();
      return closing;
    },
  };
}
