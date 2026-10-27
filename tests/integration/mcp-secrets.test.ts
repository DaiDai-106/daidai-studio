import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { openRuntime } from "../../src/backend/runtime.ts";
import type { McpConfig } from "../../src/shared/capabilities.ts";

test("MCP credentials are encrypted separately, redacted, survive restart and reach the transport", {
  timeout: 40_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-mcp-secret-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  let vaultContent = "{}";
  const vault = {
    available: true,
    read: async () => vaultContent,
    write: async (value: string) => {
      vaultContent = value;
    },
  };
  let app = await openRuntime(root, vault, () => {});
  const secret = "mock-mcp-credential-not-for-database";
  try {
    const project = await app.request("project.open", { path: projectPath });
    const marker = join(root, "exit");
    const config: McpConfig = {
      id: "secure-mcp",
      name: "Secure",
      enabled: true,
      scope: { kind: "project", projectId: project.id },
      modes: ["scene"],
      transport: "stdio",
      command: process.execPath,
      args: ["--experimental-strip-types", resolve("tests/fixtures/mcp-secret-stdio.ts"), marker],
      timeoutMs: 5000,
      secrets: [{ name: "DAI_TEST_SECRET", value: secret }],
    };
    assert.equal(
      (await app.request("mcp.inspect", { config, projectId: project.id })).tools.length,
      2,
    );
    const saved = await app.request("mcp.save", { config });
    assert.deepEqual(saved.secrets, [{ name: "DAI_TEST_SECRET" }]);
    assert.equal(
      JSON.stringify((await app.request("workspace.get", {})).settings).includes(secret),
      false,
    );
    assert.equal(vaultContent.includes(secret), true);
    await app.close();
    assert.equal((await readFile(join(root, "app.sqlite"))).includes(Buffer.from(secret)), false);
    app = await openRuntime(root, vault, () => {});
    const restored = (await app.request("workspace.get", {})).settings.mcpServers[0];
    assert.ok(restored);
    assert.deepEqual(restored.secrets, [{ name: "DAI_TEST_SECRET" }]);
    assert.equal(
      (await app.request("mcp.inspect", { config: restored, projectId: project.id })).tools.length,
      2,
    );
    await app.request("mcp.save", { config: { ...restored, name: "Renamed" } });
    assert.equal(
      (await app.request("mcp.inspect", { config: restored, projectId: project.id })).tools.length,
      2,
    );
    await app.request("mcp.remove", { id: config.id });
    assert.equal(vaultContent.includes(secret), false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP MCP headers reach connection checks and unsafe storage never falls back to plaintext", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-mcp-header-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  let authorization = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response("Unauthorized", { status: 401 });
  };
  const app = await openRuntime(
    root,
    {
      available: false,
      read: async () => "{}",
      write: async () => {
        throw new Error("Unexpected write");
      },
    },
    () => {},
  );
  try {
    const project = await app.request("project.open", { path: projectPath });
    const config: McpConfig = {
      id: "http-secret",
      name: "HTTP",
      enabled: true,
      scope: { kind: "global" },
      modes: ["general"],
      transport: "http",
      url: "https://example.test/mcp",
      timeoutMs: 5000,
      secrets: [{ name: "Authorization", value: "Bearer temporary-test-token" }],
    };
    await assert.rejects(app.request("mcp.inspect", { config, projectId: project.id }), /无法检查/);
    assert.equal(authorization, "Bearer temporary-test-token");
    await assert.rejects(app.request("mcp.save", { config }), /安全存储不可用/);
    assert.equal((await app.request("workspace.get", {})).settings.mcpServers.length, 0);
    await assert.rejects(
      app.request("mcp.inspect", {
        config: { ...config, secrets: [{ name: "Host", value: "invalid" }] },
        projectId: project.id,
      }),
      /名称无效/,
    );
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
