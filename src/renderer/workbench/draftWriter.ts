// Coalesce edits while preserving write order and the newest draft during an in-flight save.
export function createDraftWriter(
  save: (id: string, draft: string) => Promise<unknown>,
  report: (error: unknown) => void,
) {
  const drafts = new Map<string, { value: string; version: number; dirty: boolean }>();
  let version = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | undefined;

  async function flush() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (;;) {
      if (writing) {
        await writing;
        continue;
      }
      const pending = [...drafts].filter(([, draft]) => draft.dirty);
      if (!pending.length) return;
      for (const [, draft] of pending) draft.dirty = false;
      writing = (async () => {
        for (const [index, [id, draft]] of pending.entries()) {
          try {
            await save(id, draft.value);
          } catch (error) {
            for (const [failedId, failed] of pending.slice(index)) {
              const current = drafts.get(failedId);
              if (current === failed) current.dirty = true;
            }
            throw error;
          }
        }
      })();
      try {
        await writing;
      } finally {
        writing = undefined;
      }
    }
  }
  function set(id: string, value: string) {
    drafts.set(id, { value, version: ++version, dirty: true });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush().catch(report), 400);
  }
  return {
    set,
    flush,
    version: (id: string) => drafts.get(id)?.version,
    clear: (id: string) => {
      drafts.delete(id);
    },
    markDirty: (id: string) => {
      const draft = drafts.get(id);
      if (draft) draft.dirty = true;
    },
  };
}
