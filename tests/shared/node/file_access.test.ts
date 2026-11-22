import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readBoundedFile } from "../../../src/shared/node/file_access.ts";

test("读取期间文件增长仍受上限约束，取消时返回原始原因", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dai-file-access-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "source");
  await writeFile(path, "a");
  const handle = await open(path);
  try {
    const stat = handle.stat.bind(handle);
    context.mock.method(handle, "stat", async () => {
      const before = await stat();
      await appendFile(path, "bc");
      return before;
    });
    assert.equal((await readBoundedFile(handle, 3)).toString(), "abc");
    await assert.rejects(readBoundedFile(handle, 4), /文件超过/);

    const controller = new AbortController();
    const reason = new Error("读取已取消");
    context.mock.method(handle, "stat", async () => {
      controller.abort(reason);
      return stat();
    });
    await assert.rejects(
      readBoundedFile(handle, 8, controller.signal),
      (error) => error === reason,
    );
  } finally {
    await handle.close();
  }
});
