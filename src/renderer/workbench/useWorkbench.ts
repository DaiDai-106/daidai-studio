import { useEffect, useRef, useState } from "react";
import type { ApplicationState } from "../application/useApplication.ts";
import type { Conversation, Mode } from "../types.ts";

type Action =
  | { type: "select"; id: string }
  | { type: "create"; projectId: string }
  | { type: "mode"; mode: Mode }
  | { type: "archive"; id: string }
  | { type: "delete"; id: string }
  | { type: "removeProject"; id: string }
  | { type: "openProject" }
  | { type: "step"; file: string };

function withoutKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

export function useWorkbench(application: ApplicationState) {
  const { api, workspace } = application;
  const [activeId, setActiveId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [mobileTab, setMobileTab] = useState<"scene" | "chat">("scene");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const initialized = useRef(false);
  const navigating = useRef(false);
  const projects = workspace?.projects ?? [];
  const conversations: Conversation[] = (workspace?.conversations ?? []).map((item) => ({
    ...item,
    draft: drafts[item.id] ?? item.draft,
    messages:
      item.id === activeId
        ? [...(application.view?.conversationId === item.id ? application.view.messages : [])]
        : [],
  }));
  const active = conversations.find((item) => item.id === activeId);
  const project = projects.find((item) => item.id === projectId);
  const step = active?.source?.relativePath ?? "";
  function bind(id: string, target: string) {
    setActiveId(id);
    setProjectId(target);
  }
  async function select(id: string) {
    const value = workspace?.conversations.find((item) => item.id === id);
    if (!value) return;
    await application.activate(id);
    bind(id, value.projectId);
    setMobileTab("scene");
  }
  useEffect(() => {
    if (!workspace || initialized.current) return;
    initialized.current = true;
    const first = workspace.conversations.find((item) => !item.archived);
    if (first) void application.run(() => select(first.id));
    else if (workspace.projects[0]) setProjectId(workspace.projects[0].id);
  });
  async function create(target: string) {
    if (!target) return openProject();
    const conversation = await api.createConversation(target);
    if (target === projectId && active?.mode === "scene")
      await api.updateConversation({ id: conversation.id, mode: "scene" });
    await application.refresh();
    await application.activate(conversation.id);
    bind(conversation.id, target);
  }
  async function openProject() {
    const project = await api.openProject();
    if (!project) return;
    let state = await application.refresh();
    let first = state.conversations.find((item) => item.projectId === project.id && !item.archived);
    let hasHistory = state.conversations.some((item) => item.projectId === project.id);
    while (!first && state.nextCursor) {
      const page = await application.loadMore(state.nextCursor);
      if (!page) break;
      state = page;
      hasHistory ||= state.conversations.some((item) => item.projectId === project.id);
      first = state.conversations.find((item) => item.projectId === project.id && !item.archived);
    }
    if (first) {
      await application.activate(first.id);
      bind(first.id, project.id);
    } else if (hasHistory) {
      await application.activate("");
      setActiveId("");
      setProjectId(project.id);
    } else await create(project.id);
  }
  async function apply(action: Action) {
    switch (action.type) {
      case "select":
        await select(action.id);
        return;
      case "create":
        await create(action.projectId);
        return;
      case "openProject":
        await openProject();
        return;
      case "removeProject":
        await api.removeProject(action.id);
        if (action.id === projectId) {
          await application.activate("");
          setActiveId("");
          setProjectId("");
        }
        await application.refresh();
        return;
      case "mode":
        if (!active) return;
        await application.updateConversation({ id: active.id, mode: action.mode });
        if (action.mode === "scene") setMobileTab("scene");
        return;
      case "archive":
      case "delete": {
        if (action.type === "archive")
          await application.updateConversation({ id: action.id, archived: true });
        else {
          await application.deleteConversation(action.id);
          setDrafts((items) => withoutKey(items, action.id));
        }
        if (action.id === activeId) {
          const next = conversations.find(
            (item) => item.id !== action.id && item.projectId === projectId && !item.archived,
          );
          if (next) await select(next.id);
          else {
            setActiveId("");
            await application.activate("");
          }
        }
        return;
      }
      case "step":
        if (!active || !project) return;
        if (action.file && !project.files.includes(action.file))
          throw new Error("请选择当前项目内的 STEP。");
        await api.selectStep(active.id, action.file);
        await application.refresh();
        return;
    }
  }
  function request(action: Action) {
    if (navigating.current) return Promise.resolve(false);
    navigating.current = true;
    return application
      .run(async () => {
        try {
          if (application.workspace?.busyConversationId)
            throw new Error("请先停止当前模型请求，再切换对话、模式或 STEP。");
          await apply(action);
          return true;
        } finally {
          navigating.current = false;
        }
      })
      .then((result) => result === true);
  }
  function update(patch: Partial<Pick<Conversation, "draft" | "modelId" | "thinkingLevel">>) {
    if (!active) return;
    const id = active.id;
    if (patch.draft !== undefined) setDrafts((items) => ({ ...items, [id]: patch.draft ?? "" }));
    void application.run(async () => {
      await application.updateConversation({
        id,
        ...(patch.draft !== undefined ? { draft: patch.draft } : {}),
        ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
        ...(patch.thinkingLevel !== undefined ? { thinkingLevel: patch.thinkingLevel } : {}),
      });
    });
  }
  async function send(images: import("../../shared/application.ts").ChatImage[] = []) {
    if (!active || (!active.draft.trim() && !images.length)) return false;
    const id = active.id;
    const draft = active.draft;
    const text = draft.trim();
    const result = await application.run(async () => {
      await api.sendMessage(id, crypto.randomUUID(), text, images);
      setDrafts((items) => (items[id] === draft ? { ...items, [id]: "" } : items));
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
    step,
    selectStep: (file: string) => {
      if (file !== step) request({ type: "step", file });
    },
    mobileTab,
    setMobileTab,
    update,
    send,
    select: (id: string) => {
      if (id !== activeId) request({ type: "select", id });
    },
    create: (target = projectId) => request({ type: "create", projectId: target }),
    openProject: () => request({ type: "openProject" }),
    removeProject: (id: string) => request({ type: "removeProject", id }),
    setMode: (mode: Mode) => {
      if (mode !== active?.mode) request({ type: "mode", mode });
    },
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
