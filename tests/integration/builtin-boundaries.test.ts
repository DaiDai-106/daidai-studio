import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("builtin MCP modules do not import desktop implementations or the durable runtime", async () => {
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (entry.name.endsWith(".ts")) {
        const source = await readFile(path, "utf8");
        assert.doesNotMatch(source, /from\s+["'][^"']*src\/backend\//, path);
        assert.doesNotMatch(source, /from\s+["']@earendil-works\/pi-durable["']/, path);
      }
    }
  }
  await inspect(resolve("resources/mcp"));
});
