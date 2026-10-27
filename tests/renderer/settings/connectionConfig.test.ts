import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mcpConfig,
  mcpServer,
  parseMcpConfig,
  validMcpConfig,
} from "../../../src/renderer/settings/connectionConfig.ts";
import type { McpServer } from "../../../src/renderer/types.ts";

test("MCP import preserves separate arguments and explicitly configured env values", () => {
  assert.deepEqual(
    parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          cad: {
            command: "python",
            args: ["a folder/server.py", "--name", "part one"],
            env: { DEMO_SECRET: "placeholder" },
            headers: { Authorization: "placeholder" },
            enabled: true,
          },
        },
      }),
    ),
    {
      name: "cad",
      transport: "stdio",
      target: "python",
      args: ["a folder/server.py", "--name", "part one"],
      secrets: [{ name: "DEMO_SECRET", value: "placeholder" }],
    },
  );
});

test("MCP import accepts an HTTP service without inventing command arguments", () => {
  assert.deepEqual(parseMcpConfig('{"mcpServers":{"remote":{"url":"https://example.com/mcp"}}}'), {
    name: "remote",
    transport: "http",
    target: "https://example.com/mcp",
    args: [],
  });
});
test("MCP argv preserves empty arguments, whitespace and embedded newlines through import and saved projections", () => {
  const args = ["", "one\ntwo", "with spaces", "--flag=value"];
  const imported = parseMcpConfig(
    JSON.stringify({ mcpServers: { sample: { command: "node", args } } }),
  );
  assert.deepEqual(imported.args, args);
  const config = {
    id: "sample",
    name: "Sample",
    enabled: true,
    scope: { kind: "global" as const },
    modes: ["scene" as const],
    transport: "stdio" as const,
    command: "node",
    args,
    timeoutMs: 1000,
  };
  assert.deepEqual(mcpConfig(mcpServer(config)), config);
});

test("MCP import rejects malformed JSON, invalid services and ambiguous transports", () => {
  assert.throws(() => parseMcpConfig("{"), SyntaxError);
  for (const config of [
    null,
    { mcpServers: [] },
    { mcpServers: {} },
    { mcpServers: { a: {}, b: {} } },
    { mcpServers: { cad: [] } },
    { mcpServers: { " ": { command: "node" } } },
    { mcpServers: { cad: {} } },
    { mcpServers: { cad: { command: "node", url: "http://example.com" } } },
    { mcpServers: { cad: { command: " " } } },
    { mcpServers: { cad: { url: "file:///tmp/server" } } },
    { mcpServers: { cad: { command: "node", args: "server.js" } } },
    { mcpServers: { cad: { command: "node", args: [1] } } },
  ]) {
    assert.throws(() => parseMcpConfig(JSON.stringify(config)));
  }
});

test("MCP form validation requires a target, mode and positive integer timeout", () => {
  const config: McpServer = {
    id: "cad",
    name: "CAD",
    builtin: false,
    enabled: true,
    transport: "stdio",
    target: "python",
    args: ["server.py"],
    scope: { kind: "global" },
    modes: ["scene"],
    timeout: 120,
    checked: false,
  };
  assert.equal(validMcpConfig(config), true);
  assert.equal(
    validMcpConfig({ ...config, transport: "http", target: "https://example.com/mcp" }),
    true,
  );
  for (const change of [
    { name: " " },
    { target: " " },
    { modes: [] },
    { timeout: 0 },
    { timeout: 1.5 },
    { timeout: Number.NaN },
    { transport: "http" as const, target: "not-a-url" },
  ]) {
    assert.equal(validMcpConfig({ ...config, ...change }), false);
  }
});
