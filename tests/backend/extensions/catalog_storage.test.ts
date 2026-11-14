import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCatalogStorage } from "../../../src/backend/extensions/catalog_storage.ts";

test("来源配置持久化，目录缓存在进程内复用且重建实例后消失", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "dai-catalog-cache-"));
  const root = join(dataRoot, "catalog");
  const storage = createCatalogStorage(dataRoot);
  try {
    await storage.write("sources.json", { companyUrl: "https://example.com" });
    await storage.write("origins.json", []);
    await storage.cached("company", false, async () => ["fresh"]);
    assert.deepEqual(
      (
        await storage.cached("company", false, async () => {
          throw new Error("must use memory");
        })
      ).data,
      ["fresh"],
    );
    assert.deepEqual((await readdir(root)).sort(), ["origins.json", "sources.json"]);
    const restarted = createCatalogStorage(dataRoot);
    assert.deepEqual(await restarted.read("sources.json", {}), {
      companyUrl: "https://example.com",
    });
    await assert.rejects(
      restarted.cached("company", false, async () => {
        throw new Error("offline");
      }),
      /offline/,
    );
    await writeFile(join(root, "sources.json"), "{");
    await assert.rejects(storage.read("sources.json", {}), /配置损坏/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("并发请求去重，五分钟后更新，离线回退限于本进程且最多保留 100 项", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const dataRoot = await mkdtemp(join(tmpdir(), "dai-catalog-cache-"));
  const storage = createCatalogStorage(dataRoot);
  let calls = 0;
  let finish!: (value: string[]) => void;
  const pending = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  const load = () => {
    calls++;
    return pending;
  };
  try {
    const a = storage.cached("shared", true, load);
    const b = storage.cached("shared", true, load);
    finish(["v1"]);
    assert.deepEqual(
      (await Promise.all([a, b])).map((result) => result.data),
      [["v1"], ["v1"]],
    );
    assert.equal(calls, 1);
    now += 300_001;
    assert.deepEqual((await storage.cached("shared", false, async () => ["v2"])).data, ["v2"]);
    const stale = await storage.cached("shared", true, async () => {
      throw new Error("offline");
    });
    assert.deepEqual(stale.data, ["v2"]);
    assert.equal(stale.stale, true);
    assert.equal(stale.error, "offline");
    for (let i = 0; i < 100; i++) await storage.cached(String(i), false, async () => i);
    await assert.rejects(
      storage.cached("shared", false, async () => {
        throw new Error("evicted");
      }),
      /evicted/,
    );
    assert.deepEqual(await readdir(dataRoot), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
