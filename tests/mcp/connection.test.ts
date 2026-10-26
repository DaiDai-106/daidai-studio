import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type McpConnection, openMcpConnection } from "../../src/backend/mcp/connection.ts";
import { serveMcpHttp } from "../fixtures/mcp-http.ts";

async function verifyTools(connection: McpConnection) {
  assert.deepEqual(
    (await connection.client.listTools()).map((tool) => tool.name),
    ["echo", "status"],
  );
  const result = await connection.client.callTool("echo", { value: "plain MCP result" });
  assert.deepEqual(result.content, [{ type: "text", text: "plain MCP result" }]);
  assert.equal(result.structuredContent, undefined);
}

test("external stdio uses the same entry and waits for process exit after repeated close", {
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-mcp-stdio-"));
  const marker = join(root, "exit");
  const connection = await openMcpConnection({
    kind: "stdio",
    options: {
      command: process.execPath,
      args: [
        "--experimental-strip-types",
        fileURLToPath(new URL("../fixtures/mcp-stdio.ts", import.meta.url)),
        marker,
      ],
      stderr: "pipe",
    },
  });
  try {
    await verifyTools(connection);
    const protocolClose = connection.client.close();
    await Promise.all([
      protocolClose,
      connection.close().then(async () => assert.equal(await readFile(marker, "utf8"), "closed")),
      connection.close().then(async () => assert.equal(await readFile(marker, "utf8"), "closed")),
    ]);
  } finally {
    await connection.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("remote HTTP uses the same entry, paginates tools and deletes its session on close", {
  timeout: 10_000,
}, async () => {
  const remote = await serveMcpHttp();
  let connection: McpConnection | undefined;
  try {
    connection = await openMcpConnection({ kind: "http", options: { url: remote.url } });
    await verifyTools(connection);
    await Promise.all([connection.close(), connection.close()]);
    assert.equal(remote.deleted, 1);
  } finally {
    await connection?.close();
    await remote.close();
  }
});
