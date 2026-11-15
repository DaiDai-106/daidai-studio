import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeJson } from "../../../src/shared/node/write_json.ts";

test("JSON 写入替换旧文件、限制权限，失败后清理临时文件并允许重试", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-write-json-"));
  const path = join(root, "settings.json");
  try {
    await writeJson(path, { value: "initial" });
    await writeJson(path, { value: "old" });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await assert.rejects(writeJson(path, circular), TypeError);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { value: "old" });
    await rm(path);
    await mkdir(path);
    await assert.rejects(writeJson(path, { value: "new" }));
    assert.deepEqual(await readdir(root), ["settings.json"]);
    assert.ok((await stat(path)).isDirectory());
    await rm(path, { recursive: true });
    await writeJson(path, { value: "new" });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { value: "new" });
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
