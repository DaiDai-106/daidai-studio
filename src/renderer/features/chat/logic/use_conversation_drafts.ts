import { useEffect, useRef, useState } from "react";
import type { ApplicationState } from "../../../app/logic/use_application.ts";
import { createDraftWriter } from "./draft_writer.ts";

// 草稿缓存及退出前持久化由会话草稿统一管理。
export function useConversationDrafts(application: ApplicationState) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const writerRef = useRef<ReturnType<typeof createDraftWriter> | null>(null);
  writerRef.current ??= createDraftWriter(
    (id, draft) => application.updateConversation({ id, draft }),
    application.report,
  );
  const writer = writerRef.current;

  useEffect(() => {
    const flushOnUnload = () => {
      void writer.flush().catch(application.report);
    };
    window.addEventListener("beforeunload", flushOnUnload);
    const unsubscribe = window.desktop.onBeforeQuit(async () => {
      try {
        await writer.flush();
      } catch (error) {
        application.report(error);
        throw error;
      }
    });
    return () => {
      window.removeEventListener("beforeunload", flushOnUnload);
      unsubscribe();
      flushOnUnload();
    };
  }, [writer, application.report]);

  function clearDraft(id: string) {
    writer.clear(id);
    setDrafts((items) => {
      const next = { ...items };
      delete next[id];
      return next;
    });
  }
  return { drafts, setDrafts, writer, clearDraft };
}
