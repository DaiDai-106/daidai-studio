import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openRuntime } from "../../src/backend/runtime.ts";
import { serveMcpHttp } from "../fixtures/mcp-http.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

test("external tool budgets include descriptions and rejected pages can be narrowed without leaking declarations", {
  timeout: 15_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-mcp-budget-"));
  const path = join(root, "project");
  await mkdir(path);
  const remote = await serveMcpHttp(
    Array.from({ length: 20 }, (_, index) => ({
      name: `wide_${index}`,
      description: "Detailed service documentation. ".repeat(300),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    })),
  );
  const planner = await servePlanner((request) => {
    const results = turnResults(request);
    if (results.count === 0)
      return { id: "large", name: "mcp_list_tools", args: { serverId: "wide", limit: 20 } };
    if (results.count === 1) {
      assert.match(
        request.messages.find((message) => message.tool_call_id === "large")?.content ?? "",
        /预算/,
      );
      assert.deepEqual(
        request.tools?.map((tool) => tool.function.name),
        ["mcp_list_tools"],
      );
      return { id: "small", name: "mcp_list_tools", args: { serverId: "wide", limit: 1 } };
    }
    const catalog = results.read<{ items: { name: string }[] }>("small");
    assert.equal(catalog.items.length, 1);
    const tool = catalog.items[0];
    assert.ok(tool);
    assert.deepEqual(
      request.tools?.map((item) => item.function.name).sort(),
      ["mcp_list_tools", tool.name].sort(),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(request.tools)) < 130000);
    if (results.count === 2) return { id: "call", name: tool.name, args: {} };
    assert.equal(
      request.messages.find((message) => message.tool_call_id === "call")?.content,
      "ready",
    );
    return { text: "Loaded only the requested tool." };
  });
  const app = await openRuntime(
    root,
    { available: false, read: async () => "{}", write: async () => {} },
    () => {},
  );
  try {
    await app.request("provider.save", {
      config: {
        id: "planner",
        providerType: "local",
        name: "MCP budget planner",
        authMethod: "none",
        endpoint: planner.endpoint,
        enabled: true,
        persistCredentials: false,
        models: [
          { id: "budget", name: "Budget", context: 128000, output: 1000, reasoning: "标准" },
        ],
      },
    });
    const project = await app.request("project.open", { path });
    await app.request("mcp.save", {
      config: {
        id: "wide",
        name: "Wide service",
        enabled: true,
        scope: { kind: "project", projectId: project.id },
        modes: ["general"],
        transport: "http",
        url: remote.url,
        timeoutMs: 5000,
      },
    });
    const { id } = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.send", { id, requestId: "budget", text: "Use a scoped tool." });
    for (let index = 0; index < 500; index++) {
      if (!(await app.request("workspace.get", {})).busyConversationId) break;
      await setTimeout(10);
    }
    assert.equal((await app.request("workspace.get", {})).busyConversationId, null);
    assert.deepEqual(planner.failures, []);
    assert.equal(planner.requests.length, 4);
    assert.deepEqual(remote.calls, [{ name: "wide_0", args: {} }]);
    assert.equal(remote.deleted, 1);
  } finally {
    await app.close();
    await planner.close();
    await remote.close();
    await rm(root, { recursive: true, force: true });
  }
});
