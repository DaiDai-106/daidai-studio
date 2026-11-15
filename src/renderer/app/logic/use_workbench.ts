import { useRef, useState } from "react";
import type { Conversation } from "../../features/chat/logic/types.ts";
import { useConversationDrafts } from "../../features/chat/logic/use_conversation_drafts.ts";
import type { ApplicationState } from "./use_application.ts";
import { useWorkbenchNavigation } from "./use_workbench_navigation.ts";

// 协调工作台的项目、对话和草稿，界面本身由各功能组件负责。
export function useWorkbench(application: ApplicationState) {
  const { api } = application;
  const draftState = useConversationDrafts(application);
  const { setDrafts, writer } = draftState;
  const { projects, conversations, active, project, projectId, activeId, createProject, request } =
    useWorkbenchNavigation(application, draftState);
  const [accessPending, setAccessPending] = useState(false);
  const accessPendingRef = useRef(false);

  function update(
    patch: Partial<Pick<Conversation, "draft" | "modelId" | "thinkingLevel" | "accessMode">>,
  ) {
    if (!active) return;
    const id = active.id;
    if (patch.draft !== undefined) {
      setDrafts((items) => ({ ...items, [id]: patch.draft ?? "" }));
      writer.set(id, patch.draft);
    }
    if (patch.accessMode !== undefined) {
      const accessMode = patch.accessMode;
      if (accessPendingRef.current) return;
      accessPendingRef.current = true;
      setAccessPending(true);
      void application.run(async () => {
        try {
          await application.updateConversation({ id, accessMode });
        } finally {
          accessPendingRef.current = false;
          setAccessPending(false);
        }
      });
    }
    if (patch.modelId !== undefined || patch.thinkingLevel !== undefined)
      void application.run(async () => {
        await application.updateConversation({
          id,
          ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
          ...(patch.thinkingLevel !== undefined ? { thinkingLevel: patch.thinkingLevel } : {}),
        });
      });
  }

  async function send(images: import("../../../contracts/application.ts").ChatImage[] = []) {
    if (!active || accessPendingRef.current || (!active.draft.trim() && !images.length))
      return false;
    const id = active.id;
    const draft = active.draft;
    const text = draft.trim();
    const version = writer.version(id);
    const result = await application.run(async () => {
      await writer.flush();
      await api.sendMessage(id, crypto.randomUUID(), text, images, "followUp");
      if (writer.version(id) === version) {
        writer.clear(id);
        setDrafts((items) => ({ ...items, [id]: "" }));
      } else {
        // 提交会清空持久草稿；发送期间的新编辑需要重新保存。
        writer.markDirty(id);
        void writer.flush().catch(application.report);
      }
      return true;
    });
    return result === true;
  }
  return {
    projects,
    conversations,
    active,
    project,
    projectId,
    update,
    accessPending,
    send,
    select: (id: string) => {
      if (id !== activeId) request({ type: "select", id });
    },
    home: () => request({ type: "home" }),
    selectProject: (id: string) => request({ type: "selectProject", id }),
    createProject,
    fork: (id: string) => request({ type: "fork", id }),
    create: (target = projectId) => request({ type: "create", projectId: target }),
    removeProject: (id: string) => request({ type: "removeProject", id }),
    archive: (id: string) => request({ type: "archive", id }),
    deleteConversation: (id: string) => request({ type: "delete", id }),
    restore: (id: string) => {
      void application.run(() => application.updateConversation({ id, archived: false }));
    },
    rename: (id: string, title: string) => {
      void application.run(() => application.updateConversation({ id, title }));
    },
  };
}
