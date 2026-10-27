import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord, Storage } from "@earendil-works/pi-durable";
import { scanJournalEntries } from "../../src/backend/journal.ts";

test("journal scan follows conversation and entry pages without changing their order", async () => {
  const calls: string[] = [];
  const storage = {
    async scanConversations(_query: unknown, _limit: number, cursor?: string) {
      calls.push(`conversations:${cursor ?? "first"}`);
      return cursor ? { items: [{ id: 2 }] } : { items: [{ id: 1 }], next: "next" };
    },
    async scanEntries(query: { conversationId: number }, _limit: number, cursor?: string) {
      calls.push(`entries:${query.conversationId}:${cursor ?? "first"}`);
      if (query.conversationId === 1 && !cursor) return { items: [{ id: 1 }], next: "next" };
      return { items: [{ id: query.conversationId === 1 ? 2 : 3 }] };
    },
  } as unknown as Storage;
  const entries: EntryRecord[] = [];
  for await (const entry of scanJournalEntries(storage)) entries.push(entry);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [1, 2, 3],
  );
  assert.deepEqual(calls, [
    "conversations:first",
    "entries:1:first",
    "entries:1:next",
    "conversations:next",
    "entries:2:first",
  ]);
});
