import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openMcpConnection } from "../../src/backend/mcp/connection.ts";

for (const reason of ["abort", "timeout", "close"] as const) {
  test(`standard stdio ${reason} settles the SDK handler and joins its service`, {
    timeout: 10_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dai-stdio-cancel-"));
    const ready = join(root, "ready"),
      ended = join(root, "ended");
    const connection = await openMcpConnection({
      kind: "stdio",
      options: {
        command: process.execPath,
        args: ["--experimental-strip-types", resolve("tests/fixtures/mcp-wait.ts"), ready, ended],
      },
    });
    try {
      const controller = new AbortController();
      const rejected = assert.rejects(
        connection.client.callTool(
          "wait",
          {},
          {
            signal: controller.signal,
            timeoutMs: reason === "timeout" ? 300 : 5000,
          },
        ),
        /abort|closed|timed out/i,
      );
      for (let i = 0; i < 200; i++) {
        if (await readFile(ready, "utf8").catch(() => "")) break;
        await setTimeout(10);
      }
      assert.equal(await readFile(ready, "utf8"), "ready");
      if (reason === "abort") controller.abort();
      if (reason === "close") await connection.close();
      await rejected;
      await Promise.all([connection.close(), connection.close()]);
      assert.equal(await readFile(ended, "utf8"), "stopped");
    } finally {
      await connection.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
