import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { openRuntime } from "../../src/backend/runtime.ts";
import type { McpConfig } from "../../src/shared/capabilities.ts";

test("MCP settings persist scoped argv, inspect real tools, cancel startup and await process cleanup", {
  timeout: 40_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-mcp-settings-")),
    path = join(root, "project");
  await mkdir(path);
  const vault = { available: false, read: async () => "{}", write: async () => {} };
  let app = await openRuntime(root, vault, () => {});
  try {
    const project = await app.request("project.open", { path });
    const marker = join(root, "exit marker");
    const config: McpConfig = {
      id: "custom-mcp",
      name: "Generic service",
      enabled: true,
      scope: { kind: "project", projectId: project.id },
      modes: ["scene"],
      transport: "stdio",
      command: process.execPath,
      args: ["--experimental-strip-types", resolve("tests/fixtures/mcp-stdio.ts"), marker],
      timeoutMs: 5000,
    };
    const inspected = await app.request("mcp.inspect", { config, projectId: project.id });
    assert.deepEqual(
      inspected.tools.map((tool) => tool.name),
      ["echo", "status"],
    );
    assert.equal(await readFile(marker, "utf8"), "closed");
    await app.request("mcp.save", { config });
    assert.deepEqual((await app.request("workspace.get", {})).settings.mcpServers, [config]);
    await assert.rejects(
      app.request("mcp.save", { config: { ...config, id: "builtin.cad" } }),
      /内置/,
    );
    await assert.rejects(
      app.request("mcp.save", {
        config: { ...config, scope: { kind: "project", projectId: "missing" } },
      }),
      /项目/,
    );
    const ready = join(root, "ready"),
      closed = join(root, "stopped");
    const pending = app.request("mcp.inspect", {
      config: {
        ...config,
        args: [
          "--experimental-strip-types",
          resolve("tests/fixtures/mcp-stalled.ts"),
          ready,
          closed,
        ],
        timeoutMs: 10000,
      },
      projectId: project.id,
    });
    const rejected = assert.rejects(pending, /已停止/);
    for (let index = 0; index < 100; index++) {
      if (await readFile(ready, "utf8").catch(() => "")) break;
      await setTimeout(20);
    }
    assert.equal(await readFile(ready, "utf8"), "ready");
    let updated = false;
    const queued = app.request("settings.update", { theme: "dark" }).then((settings) => {
      updated = true;
      return settings;
    });
    await setImmediate();
    assert.equal(updated, false, "ordinary requests must wait behind MCP discovery");
    await app.request("mcp.cancelInspect", { id: config.id });
    await rejected;
    assert.equal((await queued).theme, "dark");
    assert.equal(await readFile(closed, "utf8"), "closed");
    assert.equal(await app.request("mcp.cancelInspect", { id: config.id }), null);
    await app.close();
    app = await openRuntime(root, vault, () => {});
    assert.deepEqual((await app.request("workspace.get", {})).settings.mcpServers, [config]);
    await app.request("mcp.remove", { id: config.id });
    assert.deepEqual((await app.request("workspace.get", {})).settings.mcpServers, []);

    // Shutdown must cancel discovery before draining the queue, then await the child exit.
    const exitReady = join(root, "exit-ready"),
      exitClosed = join(root, "exit-closed");
    const inspecting = app.request("mcp.inspect", {
      config: {
        ...config,
        args: [
          "--experimental-strip-types",
          resolve("tests/fixtures/mcp-stalled.ts"),
          exitReady,
          exitClosed,
        ],
        timeoutMs: 10000,
      },
      projectId: project.id,
    });
    const cancelled = assert.rejects(inspecting, /已停止/);
    for (let index = 0; index < 100; index++) {
      if (await readFile(exitReady, "utf8").catch(() => "")) break;
      await setTimeout(20);
    }
    assert.equal(await readFile(exitReady, "utf8"), "ready");
    const beforeExit = app.request("settings.update", { theme: "light" });
    const closing = app.close();
    assert.equal(app.close(), closing, "repeated close must share the same cleanup");
    await cancelled;
    assert.equal((await beforeExit).theme, "light");
    await closing;
    assert.equal(await readFile(exitClosed, "utf8"), "closed");
    app = await openRuntime(root, vault, () => {});
    assert.equal((await app.request("workspace.get", {})).settings.theme, "light");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
