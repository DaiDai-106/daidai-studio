import { useRef, useState } from "react";
import type { CreateProjectInput } from "../../../contracts/bridge.ts";
import type { Conversation } from "../../features/chat/logic/types.ts";
import type { useConversationDrafts } from "../../features/chat/logic/use_conversation_drafts.ts";
import type { ApplicationState } from "./use_application.ts";

const emptyMessages: Conversation["messages"] = [];

type Action =
  | { type: "home" }
  | { type: "select"; id: string }
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
  const [activeId, setActiveId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [availability, setAvailability] = useState<{
    id: string;
    available: boolean | null;
  } | null>(null);

  const navigating = useRef(false);

  const projects = workspace?.projects ?? [];
  const conversations: Conversation[] = (workspace?.conversations ?? []).map((item) => ({
    ...item,
    draft: drafts[item.id] ?? item.draft,
    messages:
      item.id === activeId
        ? application.view?.conversationId === item.id
          ? application.view.messages
          : emptyMessages
        : emptyMessages,
  }));
  const active = conversations.find((item) => item.id === activeId);
  const projectInfo = projects.find((item) => item.id === projectId);
  const project =
    projectInfo && availability?.id === projectId
      ? { ...projectInfo, available: availability.available }
      : projectInfo;

  async function activate(id: string, target: string) {
    await application.activate(id);
    setActiveId(id);
    setProjectId(target);
  }

  async function select(id: string) {
    const value = workspace?.conversations.find((item) => item.id === id);
    if (!value) return;
    if (value.projectId !== projectId) {
      const checked = await api.refreshProject(value.projectId);
      setAvailability({ id: checked.id, available: checked.available });
      await application.refresh();
    }
    await activate(id, value.projectId);
  }

  async function create(target: string) {
    if (!target) throw new Error("请先选择项目。");
    const conversation = await api.createConversation(target);
    await application.refresh();
    await activate(conversation.id, target);
  }

  async function apply(action: Action) {
    switch (action.type) {
      case "home":
        await activate("", "");
        return;
      case "select":
        await select(action.id);
        return;
      case "fork": {
        const fork = await api.forkConversation(action.id);
        await application.refresh();
        await activate(fork.id, fork.projectId);
        return;
      }
      case "selectProject":
        {
          const checked = await api.refreshProject(action.id);
          setAvailability({ id: checked.id, available: checked.available });
        }
        await application.refresh();
        await activate("", action.id);
        return;
      case "create":
        await create(action.projectId);
        return;
      case "removeProject":
        await api.removeProject(action.id);
        if (action.id === projectId) {
          await activate("", "");
        }
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
        if (action.id === activeId) {
          const next = conversations.find(
            (item) => item.id !== action.id && item.projectId === projectId && !item.archived,
          );
          if (next) await select(next.id);
          else {
            await activate("", projectId);
          }
        }
        return;
      }
    }
  }

  async function createProject(draft: CreateProjectInput) {
    if (navigating.current) return false;
    navigating.current = true;
    return (
      (await application.run(async () => {
        try {
          await writer.flush();
          const project = await api.createProject(draft);
          if (!project) return false;
          await application.refresh();
          await activate("", project.id);
          return true;
        } finally {
          navigating.current = false;
        }
      })) === true
    );
  }

  function request(action: Action) {
    if (navigating.current) return Promise.resolve(false);
    navigating.current = true;
    return application
      .run(async () => {
        try {
          await writer.flush();
          await apply(action);
          return true;
        } finally {
          navigating.current = false;
        }
      })
      .then((result) => result === true);
  }

  return {
    projects,
    conversations,
    active,
    project,
    projectId,
    activeId,
    createProject,
    request,
  };
}
