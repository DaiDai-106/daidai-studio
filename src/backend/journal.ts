import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Cursor, EntryRecord, Storage } from "@earendil-works/pi-durable";

// Scan each conversation in its existing order; callers decide how to handle entries.
export async function* scanJournalEntries(storage: Storage): AsyncGenerator<EntryRecord> {
  let conversations: Cursor | undefined;
  do {
    const page = await storage.scanConversations(
      { order: "ascending" },
      100,
      conversations,
      context,
    );
    for (const conversation of page.items) {
      let cursor: Cursor | undefined;
      do {
        const entries = await storage.scanEntries(
          { conversationId: conversation.id, order: "ascending" },
          100,
          cursor,
          context,
        );
        yield* entries.items;
        cursor = entries.next;
      } while (cursor);
    }
    conversations = page.next;
  } while (conversations);
}
