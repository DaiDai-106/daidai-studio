import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type CadResponse,
  type CadToolName,
  cadInputs,
  cadTools,
  validateCadInput,
} from "./contract.ts";
import { createResources } from "./resources.ts";
import type { ServerConfig } from "./types.ts";
import { CadWorker } from "./worker.ts";

// Both desktop and standalone clients use this one SDK service and public contract.
export function createCadServer(config: ServerConfig, directory: string) {
  const outputRoot = join(directory, "outputs");
  const resources = createResources(
    outputRoot,
    config.limits?.maxTotalResourceBytes ?? 2 * 1024 ** 3,
    (config.limits?.maxRetainedJobs ?? 128) * 11,
  );
  const server = new Server(
    { name: "cad-mcp", version: "0.2.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  let worker: Promise<CadWorker> | undefined;
  let releasing = Promise.resolve();
  let closing: Promise<void> | undefined;
  let closed = false;
  function release(owned = worker) {
    if (worker === owned) worker = undefined;
    releasing = releasing.then(async () => {
      await owned?.then(
        (value) => value.close(),
        () => undefined,
      );
    });
    return releasing;
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: cadTools }));
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    try {
      return resources.list(request.params?.cursor);
    } catch {
      throw new McpError(ErrorCode.InvalidParams, "Invalid CAD resource cursor.");
    }
  });
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    try {
      return await resources.read(params.uri);
    } catch {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Cannot read CAD resource: use a registered URI; resources/read is limited to 1 MiB.",
      );
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (closed) throw new McpError(ErrorCode.InternalError, "CAD service is closed.");
    if (!Object.hasOwn(cadInputs, request.params.name))
      throw new McpError(ErrorCode.InvalidParams, "Unknown CAD tool.");
    const name = request.params.name as CadToolName;
    const input = request.params.arguments ?? {};
    try {
      validateCadInput(name, input);
    } catch {
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${name}.`);
    }
    extra.signal.throwIfAborted();
    let owned: Promise<CadWorker> | undefined;
    // Cancellation owns this native generation, never a subsequently restarted worker.
    if (["cad_import_step", "cad_build_display", "cad_wait_job"].includes(name))
      extra.signal.addEventListener(
        "abort",
        () => {
          if (owned) void release(owned).catch(() => console.error("CAD worker shutdown failed."));
        },
        { once: true },
      );
    try {
      await releasing;
      extra.signal.throwIfAborted();
      if (!worker) {
        worker = (async () => {
          await mkdir(outputRoot, { recursive: true, mode: 0o700 });
          return CadWorker.start({ ...config, stagingRoot: join(directory, "work"), outputRoot });
        })();
      }
      owned = worker;
      const active = await owned;
      const operation = name === "cad_wait_job" ? "cad_get_job" : name;
      let envelope: CadResponse = await active.request(operation, input, extra.signal);
      while (
        name === "cad_wait_job" &&
        envelope.ok &&
        "status" in envelope.data &&
        ["queued", "running", "cancelling"].includes(String(envelope.data.status))
      ) {
        const token = request.params._meta?.progressToken;
        if (token !== undefined)
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken: token,
              progress: 0,
              message:
                "phase" in envelope.data
                  ? String(envelope.data.phase)
                  : String(envelope.data.status),
            },
          });
        await setTimeout(100, undefined, { signal: extra.signal });
        envelope = await active.request(operation, input, extra.signal);
      }
      let metadata: Record<string, unknown> | undefined;
      if (
        envelope.ok &&
        "kind" in envelope.data &&
        envelope.data.status === "succeeded" &&
        envelope.data.kind === "display"
      ) {
        const display = envelope.data.result;
        await resources.register(display);
        metadata = {
          "dai/display": {
            schemaVersion: 1,
            kind: "cad-display",
            source: display.summary.source,
            manifest: display.manifest,
          },
        };
      }
      const json = JSON.stringify(envelope);
      return {
        content: [
          {
            type: "text" as const,
            text:
              Buffer.byteLength(json) <= 60_000
                ? json
                : JSON.stringify({
                    ok: true,
                    summary: "Result exceeds text budget; request a smaller page.",
                    nextCursor:
                      envelope.ok && "nextCursor" in envelope.data
                        ? envelope.data.nextCursor
                        : undefined,
                  }),
          },
        ],
        structuredContent: envelope,
        isError: !envelope.ok,
        ...(metadata ? { _meta: metadata } : {}),
      };
    } catch {
      if (owned) await release(owned);
      throw new McpError(
        ErrorCode.InternalError,
        "CAD operation could not complete; its native handles may have expired.",
      );
    }
  });
  function close() {
    closing ??= Promise.resolve().then(async () => {
      closed = true;
      try {
        await server.close();
      } finally {
        await release();
      }
    });
    return closing;
  }
  server.onclose = () => {
    void close().catch(() => console.error("CAD service cleanup failed."));
  };
  return { server, close };
}
