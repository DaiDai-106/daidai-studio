import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { createDraftWriter } from "../../../src/renderer/features/chat/logic/draft_writer.ts";

test("draft writer coalesces rapid changes and flushes before switching", async () => {
  const writes: string[] = [];
  const writer = createDraftWriter(
    async (id, value) => {
      writes.push(`${id}:${value}`);
    },
    (error) => {
      throw error;
    },
  );
  writer.set("1", "a");
  writer.set("1", "ab");
  writer.set("1", "abc");
  await setTimeout(500);
  assert.deepEqual(writes, ["1:abc"]);
  writer.set("1", "next");
  await writer.flush();
  assert.deepEqual(writes, ["1:abc", "1:next"]);
});

test("a newer draft survives an in-flight write and failed saves remain retryable", async () => {
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: string[] = [];
  let fail = true;
  const writer = createDraftWriter(
    async (_id, value) => {
      writes.push(value);
      if (value === "old") await barrier;
      if (value === "new" && fail) throw new Error("save failed");
    },
    (error) => {
      throw error;
    },
  );
  writer.set("1", "old");
  const first = writer.flush();
  writer.set("1", "new");
  release();
  await assert.rejects(first, /save failed/);
  fail = false;
  await writer.flush();
  assert.deepEqual(writes, ["old", "new", "new"]);
});
