import { useEffect, useRef, useState } from "react";
import type { ApplicationState } from "../application/useApplication.ts";
import type { Conversation, Mode } from "../types.ts";
import { createDraftWriter } from "./draftWriter.ts";
import {
  loadSceneReferences,
  type SceneReferenceDraft,
  saveSceneReferences,
  verifySceneReference,
} from "./sceneReferenceDrafts.ts";

export type { SceneReferenceDraft } from "./sceneReferenceDrafts.ts";

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

function markReferenceStale(items: Record<string, SceneReferenceDraft>, id: string) {
  const reference = items[id];
  return reference && !reference.stale
    ? { ...items, [id]: { ...reference, stale: true, checking: false } }
    : items;
}

export function useWorkbench(application: ApplicationState) {
  const { api, workspace } = application;
  const [activeId, setActiveId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [mobileTab, setMobileTab] = useState<"scene" | "chat">("scene");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [initialReferences] = useState(() => {
    try {
      return { items: loadSceneReferences(window.localStorage), available: true };
    } catch {
      return { items: {}, available: false };
    }
  });
  const [sceneReferences, updateSceneReferences] = useState<Record<string, SceneReferenceDraft>>(
    initialReferences.items,
  );
  const [referenceStorageAvailable, setReferenceStorageAvailable] = useState(
    initialReferences.available,
  );
  const sceneReferencesRef = useRef(sceneReferences);
  function setSceneReferences(
    change: (items: Record<string, SceneReferenceDraft>) => Record<string, SceneReferenceDraft>,
  ) {
    const previous = sceneReferencesRef.current;
    const next = change(previous);
    if (next === previous) return;
    sceneReferencesRef.current = next;
    try {
      saveSceneReferences(window.localStorage, next);
      setReferenceStorageAvailable(true);
    } catch {
      setReferenceStorageAvailable(false);
    }
    updateSceneReferences(next);
  }
  const writerRef = useRef<ReturnType<typeof createDraftWriter> | null>(null);
  writerRef.current ??= createDraftWriter(
    (id, draft) => application.updateConversation({ id, draft }),
    application.report,
  );
  const writer = writerRef.current;
  const initialized = useRef(false);
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
    if (value.mode === "scene" && value.modelId && !value.draft.trim()) await api.startScene(id);
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
    if (target === projectId && active?.mode === "scene" && conversation.modelId)
      await api.startScene(conversation.id);
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
      if (first.mode === "scene" && first.modelId && !first.draft.trim())
        await api.startScene(first.id);
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
        if (action.mode !== "scene")
          setSceneReferences((items) => markReferenceStale(items, active.id));
        if (action.mode === "scene") {
          setMobileTab("scene");
          if (active.modelId && !active.draft.trim()) await api.startScene(active.id);
        }
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
      case "step":
        if (!active) throw new Error("没有当前对话。");
        await api.selectStep(active.id, action.file);
        setSceneReferences((items) => markReferenceStale(items, active.id));
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
          await writer.flush();
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
    if (patch.draft !== undefined) {
      setDrafts((items) => ({ ...items, [id]: patch.draft ?? "" }));
      writer.set(id, patch.draft);
    }
    if (patch.modelId !== undefined || patch.thinkingLevel !== undefined)
      void application.run(async () => {
        await application.updateConversation({
          id,
          ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
          ...(patch.thinkingLevel !== undefined ? { thinkingLevel: patch.thinkingLevel } : {}),
        });
        if (patch.modelId && active.mode === "scene" && !active.draft.trim())
          await api.startScene(id);
      });
  }
  async function send(images: import("../../shared/application.ts").ChatImage[] = []) {
    if (
      !active ||
      (!active.draft.trim() && !images.length) ||
      sceneReferences[active.id]?.stale ||
      sceneReferences[active.id]?.checking
    )
      return false;
    const id = active.id;
    const draft = active.draft;
    const text = draft.trim();
    const reference = sceneReferences[id];
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
      if (reference)
        setSceneReferences((items) => (items[id] === reference ? withoutKey(items, id) : items));
      if (writer.version(id) === version) {
        writer.clear(id);
        setDrafts((items) => ({ ...items, [id]: "" }));
      } else {
        // Sending clears the durable draft; preserve any edits made during submission.
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
    step,
    sceneReference: active ? sceneReferences[active.id] : undefined,
    referenceStorageAvailable,
    setSceneReference: (reference: SceneReferenceDraft | null) => {
      if (!active) return;
      const id = active.id;
      setSceneReferences((items) =>
        reference ? { ...items, [id]: reference } : withoutKey(items, id),
      );
    },
    invalidateSceneReference: (importId: string, revision: number) => {
      if (!active) return;
      const id = active.id;
      setSceneReferences((items) => verifySceneReference(items, id, importId, revision));
    },
    selectStep: (file: string) =>
      file === step ? Promise.resolve(true) : request({ type: "step", file }),
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
