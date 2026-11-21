import { useRef, useState } from "react";
import type { CreateProjectInput } from "../../../contracts/bridge.ts";
import type { useConversationDrafts } from "../../features/chat/logic/use_conversation_drafts.ts";
import type { ApplicationState } from "./use_application.ts";

type Action =
  | { type: "home" }
  | { type: "fork"; id: string }
  | { type: "selectProject"; id: string }
  | { type: "create"; projectId: string }
  | { type: "archive"; id: string }
  | { type: "delete"; id: string }
  | { type: "removeProject"; id: string };

export function useWorkbenchNavigation(
  application: ApplicationState,
  { drafts, writer, clearDraft }: ReturnType<typeof useConversationDrafts>,
) {
  const { api, workspace } = application;
  const [{ activeId, projectId, isNewConversation }, setSelection] = useState({
    activeId: "",
    projectId: "",
    isNewConversation: false,
  });
  const [availability, setAvailability] = useState<{
    id: string;
    available: boolean | null;
  } | null>(null);

  const navigating = useRef(false);
  const pending = useRef<{ id: string; projectId: string }>(undefined);
  const currentProject = useRef("");

  const projects = workspace?.projects ?? [];
  const activeView = application.view?.conversationId === activeId ? application.view : null;
  const conversations = (workspace?.conversations ?? []).map((item) => ({
    ...item,
    draft: drafts[item.id] ?? item.draft,
  }));
  const active = conversations.find((item) => item.id === activeId);
  const projectInfo = projects.find((item) => item.id === projectId);
  const project =
    projectInfo && availability?.id === projectId
      ? { ...projectInfo, available: availability.available }
      : projectInfo;

  async function activate(
    id: string,
    target: string,
    isNewConversation = false,
    isCurrent = () => true,
  ) {
    await application.activate(id, isCurrent);
    if (!isCurrent()) return;
    currentProject.current = target;
    setSelection({ activeId: id, projectId: target, isNewConversation });
  }

  async function checkProject(id: string) {
    const checked = await api.refreshProject(id);
    setAvailability({ id: checked.id, available: checked.available });
  }

  async function create(target: string) {
    if (!target) throw new Error("请先选择项目。");
    const conversation = await api.createConversation(target);
    await application.refresh();
    await activate(conversation.id, target, true);
  }

  async function apply(action: Action) {
    switch (action.type) {
      case "home":
        await activate("", "");
        return;
      case "fork": {
        const fork = await api.forkConversation(action.id);
        await application.refresh();
        await activate(fork.id, fork.projectId);
        return;
      }
      case "selectProject":
        await checkProject(action.id);
        await activate("", action.id);
        return;
      case "create":
        await create(action.projectId);
        return;
      case "removeProject":
        await api.removeProject(action.id);
        if (pending.current?.projectId === action.id) pending.current = undefined;
        if (action.id === projectId) await activate("", "");
        await application.refresh();
        return;
      case "archive":
      case "delete": {
        if (action.type === "archive")
          await application.updateConversation({ id: action.id, archived: true });
        else {
          await application.deleteConversation(action.id);
          clearDraft(action.id);
        }
        if (pending.current?.id === action.id) pending.current = undefined;
        if (action.id === activeId) {
          const next = conversations.find(
            (item) => item.id !== action.id && item.projectId === projectId && !item.archived,
          );
          if (next) await activate(next.id, next.projectId);
          else await activate("", projectId);
        }
        return;
      }
    }
  }

  async function navigate(task?: () => Promise<boolean>) {
    if (navigating.current) return false;
    navigating.current = true;
    try {
      const result =
        task &&
        (await application.run(async () => {
          await writer.flush();
          return task();
        }));
      // 会话选择只保留最后一次点击，项目变更仍通过同一导航锁串行执行。
      while (pending.current) {
        const target = pending.current;
        const isCurrent = () => pending.current === target;
        await application.run(async () => {
          await writer.flush();
          if (!isCurrent()) return;
          if (target.projectId !== currentProject.current) await checkProject(target.projectId);
          if (!isCurrent()) return;
          await activate(target.id, target.projectId, false, isCurrent);
        });
        if (isCurrent()) pending.current = undefined;
      }
      return result === true;
    } finally {
      navigating.current = false;
    }
  }

  function select(id: string) {
    if (id === activeId && !navigating.current) return;
    const item = workspace?.conversations.find((item) => item.id === id);
    if (!item) return;
    pending.current = { id, projectId: item.projectId };
    void navigate();
  }

  function createProject(draft: CreateProjectInput) {
    return navigate(async () => {
      const project = await api.createProject(draft);
      if (!project) return false;
      await application.refresh();
      await activate("", project.id);
      return true;
    });
  }

  return {
    projects,
    conversations,
    active,
    activeView,
    isNewConversation,
    project,
    projectId,
    select,
    createProject,
    request: (action: Action) =>
      navigate(async () => {
        await apply(action);
        return true;
      }),
  };
}
