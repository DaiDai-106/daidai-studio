import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCredentials,
  type StoredProvider,
} from "../../../src/backend/settings/credentials.ts";

test("credential changes serialize, failed writes preserve the old value, and staging is reconciled", async () => {
  let serialized = "{}";
  let fail = false;
  const vault = {
    available: true,
    read: async () => serialized,
    write: async (value: string) => {
      if (fail) throw new Error("Test vault write failure");
      serialized = value;
    },
  };
  const providers: StoredProvider[] = [];
  let credentials = await createCredentials(vault, () => providers);
  const first = await credentials.stage({ type: "api_key", key: "old-test-key" }, true);
  providers.push({ id: "one", secretRef: first } as StoredProvider);
  fail = true;
  await assert.rejects(
    credentials.store.modify("one", async () => ({ type: "api_key", key: "failed-test-key" })),
  );
  assert.deepEqual(await credentials.store.read("one"), { type: "api_key", key: "old-test-key" });
  fail = false;
  await Promise.all([
    credentials.store.modify("one", async () => ({ type: "api_key", key: "new-test-key" })),
    credentials.stage({ type: "api_key", key: "uncommitted-key" }, true),
  ]);
  credentials = await createCredentials(vault, () => providers);
  await credentials.prune();
  assert.equal(Object.keys(JSON.parse(serialized)).length, 1);
  assert.deepEqual(await credentials.store.read("one"), { type: "api_key", key: "new-test-key" });
});

test("unavailable OS storage never falls back to plaintext; temporary credentials do not survive restart", async () => {
  const vault = {
    available: false,
    read: async () => "{}",
    write: async () => {
      throw new Error("Must not write");
    },
  };
  const providers: StoredProvider[] = [];
  let credentials = await createCredentials(vault, () => providers);
  await assert.rejects(credentials.stage({ type: "api_key", key: "test" }, true), /安全存储不可用/);
  const reference = await credentials.stage({ type: "api_key", key: "session-only-key" }, false);
  providers.push({ id: "temporary", secretRef: reference } as StoredProvider);
  assert.equal(await credentials.has("temporary"), true);
  credentials = await createCredentials(vault, () => providers);
  assert.equal(await credentials.has("temporary"), false);
});
