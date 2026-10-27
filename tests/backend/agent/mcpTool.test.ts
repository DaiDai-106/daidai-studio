import assert from "node:assert/strict";
import { test } from "node:test";
import { cadTools } from "../../../resources/mcp/cad/contract.ts";
import { registerMcpTool } from "../../../src/backend/agent/mcpTool.ts";

const display = { importId: "a".repeat(64), sourceId: "source", sourceHash: "b".repeat(64) };
const placement = {
  schemaVersion: 2 as const,
  importId: display.importId,
  sourceHash: display.sourceHash,
  expectedRevision: 0,
  translation: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
};

function setup(
  meta: Record<string, unknown>,
  options: {
    prepareDisplay?: () => Promise<typeof display>;
    preparePlacement?: () => Promise<typeof placement>;
    invokeError?: boolean;
  },
  abortSignal?: AbortSignal,
) {
  const cadTool = cadTools.find((tool) => tool.name === "cad_wait_job");
  assert.ok(cadTool);
  const tool = registerMcpTool({
    name: cadTool.name,
    serverName: "cad-mcp",
    tool: cadTool,
    target(id) {
      assert.equal(id, "conversation");
    },
    async invoke() {
      return {
        isError: !!options.invokeError,
        content: [{ type: "text" as const, text: "原始计算结果" }],
        _meta: meta,
      };
    },
    ...(options.prepareDisplay ? { prepareDisplay: options.prepareDisplay } : {}),
    ...(options.preparePlacement ? { preparePlacement: options.preparePlacement } : {}),
  });
  const api = { conversationId: "conversation", details: async () => {} } as unknown as Parameters<
    typeof tool.execute
  >[1];
  const context = { abortSignal } as Parameters<typeof tool.execute>[2];
  return () => tool.execute({}, api, context);
}

function details(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("a failed desktop display handoff reports failure and preserves the calculation result", async () => {
  const run = setup(
    { "dai/display": { candidate: true } },
    {
      prepareDisplay: async () => {
        throw new Error("simulated disk failure");
      },
    },
  );
  const result = await run();
  assert.equal(result.isError, true);
  assert.match(
    result.output?.[0]?.type === "text" ? result.output[0].text : "",
    /未能接管显示资源/,
  );
  assert.match(
    result.output?.[0]?.type === "text" ? result.output[0].text : "",
    /不要直接重复导入/,
  );
  assert.ok(result.output?.some((item) => item.type === "text" && item.text === "原始计算结果"));
  assert.equal(details(details(result.details).displayError).code, "DISPLAY_PREPARE_FAILED");
  assert.equal(details(result.details).display, undefined);
});

test("a rejected placement reports failure without losing the calculation result", async () => {
  const run = setup(
    { "dai/placement": placement },
    {
      preparePlacement: async () => {
        throw new Error("simulated version conflict");
      },
    },
  );
  const result = await run();
  assert.equal(result.isError, true);
  assert.match(
    result.output?.[0]?.type === "text" ? result.output[0].text : "",
    /未能接管定位结果/,
  );
  assert.match(
    result.output?.[0]?.type === "text" ? result.output[0].text : "",
    /不要直接重复变换/,
  );
  assert.ok(result.output?.some((item) => item.type === "text" && item.text === "原始计算结果"));
  assert.equal(details(details(result.details).placementError).code, "PLACEMENT_PREPARE_FAILED");
  assert.equal(details(result.details).placement, undefined);
});

test("successful handoffs remain successful and retain their persistent identity", async () => {
  const displayResult = await setup(
    { "dai/display": { candidate: true } },
    { prepareDisplay: async () => display },
  )();
  assert.equal(displayResult.isError, false);
  assert.deepEqual(details(displayResult.details).display, display);
  const placementResult = await setup(
    { "dai/placement": placement },
    { preparePlacement: async () => placement },
  )();
  assert.equal(placementResult.isError, false);
  assert.deepEqual(details(placementResult.details).placement, placement);
});

test("when either handoff fails, neither result is advertised for publication", async () => {
  const meta = { "dai/display": { candidate: true }, "dai/placement": placement };
  for (const options of [
    {
      prepareDisplay: async () => display,
      preparePlacement: async () => {
        throw new Error("simulated failure");
      },
    },
    {
      prepareDisplay: async () => {
        throw new Error("simulated failure");
      },
      preparePlacement: async () => placement,
    },
  ]) {
    const result = await setup(meta, options)();
    assert.equal(result.isError, true);
    assert.equal(details(result.details).display, undefined);
    assert.equal(details(result.details).placement, undefined);
    assert.equal(result.diagnostics, undefined);
    assert.ok(
      result.output?.some((item) => item.type === "text" && item.text.includes("本次结果未发布")),
    );
  }
});

test("a failed MCP operation does not hand off its metadata", async () => {
  let prepared = false;
  const result = await setup(
    { "dai/display": { candidate: true } },
    {
      invokeError: true,
      prepareDisplay: async () => {
        prepared = true;
        return display;
      },
    },
  )();
  assert.equal(result.isError, true);
  assert.equal(prepared, false);
});

test("cancellation during handoff is propagated rather than reported as a save failure", async () => {
  const controller = new AbortController();
  const run = setup(
    { "dai/display": { candidate: true } },
    {
      prepareDisplay: async () => {
        controller.abort();
        throw new Error("simulated cancellation");
      },
    },
    controller.signal,
  );
  await assert.rejects(run(), { name: "AbortError" });
});
