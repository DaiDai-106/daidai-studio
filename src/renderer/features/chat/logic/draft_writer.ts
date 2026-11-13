const DRAFT_SAVE_DELAY_MS = 400;

// 合并草稿写入；保存期间的新修改不会被旧结果覆盖。
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
    timer = setTimeout(() => void flush().catch(report), DRAFT_SAVE_DELAY_MS);
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
