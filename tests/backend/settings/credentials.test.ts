import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createCredentials,
  type StoredProvider,
} from "../../../src/backend/settings/credentials.ts";

test("凭据保存在本地并在重启后恢复，多个写入不会相互覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-auth-"));
  const providers: StoredProvider[] = [];
  try {
    let credentials = await createCredentials(root, () => providers);
    const first = await credentials.stage({ type: "api_key", key: "old-test-key" });
    providers.push({ id: "one", secretRef: first } as StoredProvider);
    const [, second] = await Promise.all([
      credentials.store.modify("one", async () => ({ type: "api_key", key: "new-test-key" })),
      credentials.stage({ type: "api_key", key: "second-test-key" }),
    ]);
    providers.push({ id: "two", secretRef: second } as StoredProvider);
    credentials = await createCredentials(root, () => providers);
    assert.deepEqual(await credentials.store.read("one"), { type: "api_key", key: "new-test-key" });
    assert.deepEqual(await credentials.store.read("two"), {
      type: "api_key",
      key: "second-test-key",
    });
    const path = join(root, "auth.json");
    assert.match(await readFile(path, "utf8"), /new-test-key/);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    await credentials.remove(second);
    assert.equal((await readFile(path, "utf8")).includes("second-test-key"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("损坏的凭据文件不会被当作空文件覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-auth-invalid-"));
  try {
    await writeFile(join(root, "auth.json"), "invalid");
    await assert.rejects(createCredentials(root, () => []));
    assert.equal(await readFile(join(root, "auth.json"), "utf8"), "invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("凭据写入失败不改变当前认证，恢复目录后可以重试", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-auth-failure-"));
  const moved = `${root}-moved`;
  const providers: StoredProvider[] = [];
  try {
    const credentials = await createCredentials(root, () => providers);
    const key = await credentials.stage({ type: "api_key", key: "before" });
    providers.push({ id: "test", secretRef: key } as StoredProvider);
    await rename(root, moved);
    await assert.rejects(
      credentials.store.modify("test", async () => ({ type: "api_key", key: "after" })),
    );
    assert.equal((await credentials.store.read("test"))?.type, "api_key");
    assert.deepEqual(await credentials.store.read("test"), { type: "api_key", key: "before" });
    await rename(moved, root);
    await credentials.store.modify("test", async () => ({ type: "api_key", key: "after" }));
    assert.deepEqual(await (await createCredentials(root, () => providers)).store.read("test"), {
      type: "api_key",
      key: "after",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});
