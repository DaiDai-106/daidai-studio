import { useEffect, useRef, useState } from "react";
import { createDraftWriter } from "../../features/chat/logic/draftWriter.ts";
import type { ProjectDraft } from "../../features/projects/logic/types.ts";
import type { SceneReferenceDraft } from "../../features/scene/logic/sceneReferenceDrafts.ts";
import { useSceneReferences } from "../../features/scene/logic/useSceneReferences.ts";
import type { Conversation } from "../../shared/logic/types.ts";
import type { ApplicationState } from "./useApplication.ts";

export type { SceneReferenceDraft } from "../../features/scene/logic/sceneReferenceDrafts.ts";

type Action =
  | { type: "select"; id: string }
  | { type: "fork"; id: string }
  | { type: "selectProject"; id: string }
  | { type: "create"; projectId: string }
  | { type: "archive"; id: string }
  | { type: "delete"; id: string }
  | { type: "removeProject"; id: string };

function withoutKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

// 协调工作台的项目、对话和草稿，界面本身由各功能组件负责。
export function useWorkbench(application: ApplicationState) {
  const { api, workspace } = application;
  const [activeId, setActiveId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [availability, setAvailability] = useState<{
    id: string;
    available: boolean | null;
  } | null>(null);
  const [mobileTab, setMobileTab] = useState<"scene" | "chat">("scene");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [accessPending, setAccessPending] = useState(false);
  const accessPendingRef = useRef(false);
  const scene = useSceneReferences();

  const writerRef = useRef<ReturnType<typeof createDraftWriter> | null>(null);
  writerRef.current ??= createDraftWriter(
    (id, draft) => application.updateConversation({ id, draft }),
    application.report,
  );
  const writer = writerRef.current;
  const navigating = useRef(false);

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
  const projectInfo = projects.find((item) => item.id === projectId);
  const project =
    projectInfo && availability?.id === projectId
      ? { ...projectInfo, available: availability.available }
      : projectInfo;

  function bind(id: string, target: string) {
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
    await application.activate(id);
    bind(id, value.projectId);
    setMobileTab(value.mode === "robot" ? "chat" : "scene");
  }

  async function create(target: string) {
    if (!target) throw new Error("请先选择项目。");
    const conversation = await api.createConversation(target);
    await application.refresh();
    await application.activate(conversation.id);
    bind(conversation.id, target);
    setMobileTab(conversation.mode === "robot" ? "chat" : "scene");
  }

  async function apply(action: Action) {
    switch (action.type) {
      case "select":
        await select(action.id);
        return;
      case "fork": {
        const fork = await api.forkConversation(action.id);
        await application.refresh();
        await application.activate(fork.id);
        bind(fork.id, fork.projectId);
        return;
      }
      case "selectProject":
        {
          const checked = await api.refreshProject(action.id);
          setAvailability({ id: checked.id, available: checked.available });
        }
        await application.refresh();
        await application.activate("");
        setActiveId("");
        setProjectId(action.id);
        return;
      case "create":
        await create(action.projectId);
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
      case "archive":
      case "delete": {
        if (action.type === "archive")
          await application.updateConversation({ id: action.id, archived: true });
        else {
          await application.deleteConversation(action.id);
          writer.clear(action.id);
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
    }
  }

  async function createProject(draft: ProjectDraft) {
    if (navigating.current) return false;
    navigating.current = true;
    return (
      (await application.run(async () => {
        try {
          if (application.workspace?.busyConversationId)
            throw new Error("请先停止当前模型请求，再创建项目。");
          await writer.flush();
          const project = await api.createProject(draft);
          if (!project) return false;
          await application.refresh();
          await application.activate("");
          setActiveId("");
          setProjectId(project.id);
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
          const busyId = application.workspace?.busyConversationId;
          if (busyId && !(action.type === "select" && action.id === busyId))
            throw new Error("请先停止当前模型请求，再切换项目或会话。");
          await writer.flush();
          await apply(action);
          return true;
        } finally {
          navigating.current = false;
        }
      })
      .then((result) => result === true);
  }

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
    if (
      !active ||
      accessPendingRef.current ||
      (!active.draft.trim() && !images.length) ||
      scene.references[active.id]?.stale ||
      scene.references[active.id]?.checking
    )
      return false;
    const id = active.id;
    const draft = active.draft;
    const text = draft.trim();
    const reference = scene.references[id];
    const version = writer.version(id);
    const result = await application.run(async () => {
      await writer.flush();
      await api.sendMessage(
        id,
        crypto.randomUUID(),
        text,
        images,
        reference && {
          importId: reference.importId,
          objectId: reference.objectId,
          revision: reference.revision,
        },
      );
      if (reference) scene.removeIfSame(id, reference);
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
    sceneReference: active ? scene.references[active.id] : undefined,
    referenceStorageAvailable: scene.storageAvailable,
    setSceneReference: (reference: SceneReferenceDraft | null) => {
      if (!active) return;
      scene.set(active.id, reference);
    },
    invalidateSceneReference: (importId: string, revision: number) => {
      if (!active) return;
      scene.verify(active.id, importId, revision);
    },
    mobileTab,
    setMobileTab,
    update,
    accessPending,
    send,
    select: (id: string) => {
      if (id !== activeId) request({ type: "select", id });
    },
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
