import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPackageMcpCredentials } from "../../../src/backend/extensions/package_mcp_credentials.ts";
import { createCredentials } from "../../../src/backend/settings/credentials.ts";

test("package OAuth state uses local credentials and survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-package-auth-"));
  async function create() {
    const credentials = await createCredentials(root, () => []);
    return createPackageMcpCredentials({
      read: () => credentials.readApplicationSecret("dai:package-mcp-oauth:v1"),
      write: (value) => credentials.writeApplicationSecret("dai:package-mcp-oauth:v1", value),
    });
  }
  try {
    const first = await create();
    const server = first.credentials.forServer("example", "https://example.com/mcp");
    await server.save({
      serverUrl: "https://example.com/mcp",
      tokens: { access_token: "secret", token_type: "Bearer" },
    });
    await first.flush();
    const restarted = await create();
    assert.equal(
      restarted.credentials.tokens("example", "https://example.com/mcp")?.access_token,
      "secret",
    );
    assert.equal(restarted.credentials.tokens("example", "https://other.example/mcp"), undefined);
    assert.equal(restarted.credentials.remove("example", "https://example.com/mcp"), true);
    await restarted.flush();
    assert.equal(
      (await create()).credentials.tokens("example", "https://example.com/mcp"),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package OAuth refresh is serialized for the same server", async () => {
  const store = await createPackageMcpCredentials();
  const server = store.credentials.forServer("example", "https://example.com/mcp");
  const order: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const a = server.withRefreshLock(async () => {
    order.push("first-start");
    await waiting;
    order.push("first-end");
  });
  const b = server.withRefreshLock(async () => {
    order.push("second");
  });
  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});
