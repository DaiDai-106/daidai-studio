import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openRuntime } from "../../src/backend/runtime.ts";
import { serveMcpHttp } from "../fixtures/mcp-http.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

test("durable discovers scoped external tools, loads native declarations, validates calls and cleans up before the next turn", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-mcp-agent-")),
    path = join(root, "project");
  await mkdir(path);
  const remote = await serveMcpHttp();
  let serverId = "";
  const planner = await servePlanner((request) => {
    const user =
      request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
    assert.equal(JSON.stringify(request).includes("mock-mcp-credential-not-for-database"), false);
    assert.equal(
      JSON.stringify(request).includes(path),
      false,
      "Local project paths are not injected into model requests",
    );
    const results = turnResults(request);
    if (user === "no-tools") {
      assert.ok(
        (request.tools ?? []).every((tool) =>
          [
            "scene_list_steps",
            "scene_select_step",
            "scene_list_profiles",
            "scene_select_profile",
            "read",
            process.platform === "win32" ? "powershell" : "bash",
          ].includes(tool.function.name),
        ),
      );
      return { text: "No external tools." };
    }
    if (results.count === 0) {
      assert.deepEqual(
        request.tools?.map((tool) => tool.function.name),
        [
          "scene_list_steps",
          "scene_select_step",
          "scene_list_profiles",
          "scene_select_profile",
          "read",
          process.platform === "win32" ? "powershell" : "bash",
          "mcp_list_tools",
        ],
      );
      return { id: "discover", name: "mcp_list_tools", args: { serverId } };
    }
    const catalog = results.read<{ items: { name: string; sourceName: string }[] }>("discover");
    const echo = catalog.items.find((tool) => tool.sourceName === "echo");
    assert.ok(echo && /^mcp_[A-Za-z0-9_-]+$/.test(echo.name) && echo.name.length <= 64);
    assert.ok(request.tools?.some((tool) => tool.function.name === echo.name));
    if (results.count === 1)
      return {
        id: "echo",
        name: echo.name,
        args: user === "bad-args" ? { wrong: true } : { value: "MCP round-trip" },
      };
    if (user === "bad-args")
      assert.ok(
        request.messages.some(
          (message) =>
            message.tool_call_id === "echo" && message.content?.includes("Validation failed"),
        ),
      );
    else
      assert.equal(
        request.messages.find((message) => message.tool_call_id === "echo")?.content,
        "MCP round-trip",
      );
    return { text: "External tool completed." };
  });
  let vaultContent = "{}";
  const vault = {
    available: true,
    read: async () => vaultContent,
    write: async (value: string) => {
      vaultContent = value;
    },
  };
  let app = await openRuntime(root, vault, () => {});
  async function send(id: string, text: string) {
    await app.request("conversation.send", { id, requestId: crypto.randomUUID(), text });
    for (let index = 0; index < 500; index++) {
      if (!(await app.request("workspace.get", {})).busyConversationId) return;
      await setTimeout(10);
    }
    assert.fail("External tool turn did not finish");
  }
  try {
    await app.request("provider.save", {
      config: {
        id: "mcp",
        providerType: "local",
        name: "MCP planner",
        authMethod: "none",
        endpoint: planner.endpoint,
        enabled: true,
        persistCredentials: false,
        models: [{ id: "mcp-test", name: "MCP", context: 128000, output: 1000, reasoning: "标准" }],
      },
    });
    const project = await app.request("project.open", { path });
    serverId = "generic-service";
    const marker = join(root, "exit"),
      calls = join(root, "calls");
    const config = {
      id: serverId,
      name: "Generic",
      enabled: true,
      scope: { kind: "project" as const, projectId: project.id },
      modes: ["scene" as const],
      transport: "stdio" as const,
      command: process.execPath,
      args: [
        "--experimental-strip-types",
        resolve("tests/fixtures/mcp-secret-stdio.ts"),
        marker,
        calls,
      ],
      timeoutMs: 5000,
      secrets: [{ name: "DAI_TEST_SECRET", value: "mock-mcp-credential-not-for-database" }],
    };
    await app.request("mcp.save", { config });
    const id = (await app.request("conversation.create", { projectId: project.id })).id;
    await send(id, "no-tools");
    await app.request("conversation.update", { id, mode: "scene" });
    await send(id, "use-mcp");
    assert.deepEqual(planner.failures, []);
    assert.equal(await readFile(marker, "utf8"), "closed");
    const view = await app.request("conversation.watch", { id });
    assert.ok(
      view.messages.some(
        (message) => message.tool?.displayName === "echo" && message.tool.serverName === "Generic",
      ),
    );
    const called = (await readFile(calls, "utf8")).trim().split("\n");
    assert.equal(called.length, 1);
    await send(id, "bad-args");
    assert.deepEqual(planner.failures, []);
    assert.equal(
      (await readFile(calls, "utf8")).trim().split("\n").length,
      1,
      "Invalid arguments must not reach the remote service",
    );
    const otherPath = join(root, "other-project");
    await mkdir(otherPath);
    const otherProject = await app.request("project.open", { path: otherPath });
    const other = (await app.request("conversation.create", { projectId: otherProject.id })).id;
    await app.request("conversation.update", { id: other, mode: "scene" });
    await send(other, "no-tools");
    assert.deepEqual(planner.failures, []);
    await app.close();
    app = await openRuntime(root, vault, () => {});
    await send(id, "use-mcp-after-restart");
    assert.deepEqual(planner.failures, []);
    const httpConfig = {
      id: config.id,
      name: config.name,
      enabled: true,
      scope: config.scope,
      modes: config.modes,
      timeoutMs: config.timeoutMs,
      transport: "http" as const,
      url: remote.url,
    };
    await app.request("mcp.save", { config: httpConfig });
    await send(id, "use-http-mcp");
    assert.equal(remote.deleted, 1, "HTTP session cleanup finishes before the run becomes idle");
    assert.deepEqual(remote.calls, [{ name: "echo", args: { value: "MCP round-trip" } }]);
    await app.request("mcp.save", { config: { ...httpConfig, enabled: false } });
    await send(id, "no-tools");
    assert.deepEqual(planner.failures, []);
    const ready = join(root, "stalled-ready"),
      stopped = join(root, "stalled-closed");
    await app.request("mcp.save", {
      config: {
        ...config,
        args: [
          "--experimental-strip-types",
          resolve("tests/fixtures/mcp-stalled.ts"),
          ready,
          stopped,
        ],
      },
    });
    await app.request("conversation.send", {
      id,
      requestId: "stop-mcp-startup",
      text: "stall-mcp",
    });
    for (let index = 0; index < 200; index++) {
      if (await readFile(ready, "utf8").catch(() => "")) break;
      await setTimeout(10);
    }
    assert.equal(await readFile(ready, "utf8"), "ready");
    await app.request("conversation.stop", { id });
    assert.equal(await readFile(stopped, "utf8"), "closed");
    assert.equal((await app.request("workspace.get", {})).busyConversationId, null);
    await app.request("mcp.save", { config });
    await send(id, "use-mcp-after-cancel");
    assert.deepEqual(planner.failures, []);
    await Promise.all([rm(ready, { force: true }), rm(stopped, { force: true })]);
    await app.request("mcp.save", {
      config: {
        ...config,
        args: [
          "--experimental-strip-types",
          resolve("tests/fixtures/mcp-stalled.ts"),
          ready,
          stopped,
        ],
      },
    });
    await app.request("conversation.send", {
      id,
      requestId: "quit-mcp-startup",
      text: "stall-mcp",
    });
    for (let index = 0; index < 200; index++) {
      if (await readFile(ready, "utf8").catch(() => "")) break;
      await setTimeout(10);
    }
    assert.equal(await readFile(ready, "utf8"), "ready");
    await app.close();
    assert.equal(await readFile(stopped, "utf8"), "closed");
  } finally {
    await app.close();
    await planner.close();
    await remote.close();
    await rm(root, { recursive: true, force: true });
  }
});
