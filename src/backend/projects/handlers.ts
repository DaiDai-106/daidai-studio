import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type ConversationId,
  type Cursor,
  configure,
  type Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import type { ApplicationEvent } from "../../shared/application.ts";
import type { Artifacts } from "../artifacts/store.ts";
import type { Handlers } from "../types.ts";
import { ConversationDoc, conversationInfo, ProjectDoc, StepSourceDoc } from "./documents.ts";
import { projectDirectory, projectFiles } from "./files.ts";
import { fileHash, resolveStepPath } from "./source.ts";

export function conversationId(value: string): ConversationId {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || String(number) !== value)
    throw new Error("对话标识无效。");
  return number as ConversationId;
}
export function createProjects(
  harness: Harness,
  storage: Storage,
  modelFor: (id: string) => Model<Api> | undefined,
) {
  async function projectRecords() {
    const projects = [];
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanDocuments(
        { scope: { kind: "session" }, kind: "app.project", at: "current" },
        100,
        cursor,
        context,
      );
      for (const record of page.items)
        if (record.key) {
          const project = await harness.snapshot(ProjectDoc, record.key, context);
          if (project) projects.push(project);
        }
      cursor = page.next;
    } while (cursor);
    return projects;
  }
  async function visibleProject(id: string) {
    const project = await harness.snapshot(ProjectDoc, id, context);
    if (!project || project.hidden) throw new Error("项目已移除或不存在，请重新打开项目目录。");
    return project;
  }
  async function findSource(projectId: string, relativePath: string) {
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanDocuments(
        { scope: { kind: "session" }, kind: "app.projectStep", at: "current" },
        100,
        cursor,
        context,
      );
      for (const record of page.items) {
        if (!record.key) continue;
        const source = await harness.snapshot(StepSourceDoc, record.key, context);
        if (source?.projectId === projectId && source.relativePath === relativePath) return source;
      }
      cursor = page.next;
    } while (cursor);
    return undefined;
  }
  async function metadata(id: string) {
    const value = await harness.snapshot(ConversationDoc, conversationId(id), context);
    if (!value) throw new Error("对话不存在。");
    if (value.deletedAt) throw new Error("对话已删除，无法访问或恢复。");
    const source = value.selectedSourceId
      ? ((await harness.snapshot(StepSourceDoc, value.selectedSourceId, context)) ?? null)
      : null;
    const agent = await harness.snapshot(AgentDoc, conversationId(id), context);
    const model = modelFor(value.modelId);
    const thinking = model ? clampThinkingLevel(model, agent?.thinkingLevel ?? "off") : "off";
    return conversationInfo(
      value,
      source
        ? { id: source.id, projectId: source.projectId, relativePath: source.relativePath }
        : null,
      thinking,
    );
  }
  async function getConversation(id: string) {
    const meta = await metadata(id);
    await visibleProject(meta.projectId);
    const conversation = await harness.conversation(conversationId(id), context);
    if (!conversation) throw new Error("对话不存在。");
    return conversation;
  }
  async function sceneProfile(projectId: string, sourceId: string | null) {
    const project = await visibleProject(projectId);
    const source = sourceId ? await harness.snapshot(StepSourceDoc, sourceId, context) : null;
    if (source && source.projectId !== projectId) throw new Error("STEP 不属于当前项目。");
    if (source?.sceneProfileId) return { id: source.sceneProfileId, scope: "source" as const };
    return project.sceneProfileId
      ? { id: project.sceneProfileId, scope: "project" as const }
      : null;
  }
  async function setSceneProfile(
    projectId: string,
    sourceId: string | null,
    profileId: string,
    scope: "project" | "source",
  ) {
    const project = await visibleProject(projectId);
    const source = sourceId ? await harness.snapshot(StepSourceDoc, sourceId, context) : null;
    if (scope === "source" && (!source || source.projectId !== projectId))
      throw new Error("请先选择当前项目的 STEP。");
    await harness.commit(async (tx) => {
      if (scope === "source" && source)
        (await tx.doc(StepSourceDoc, source.id, source)).sceneProfileId = profileId;
      else (await tx.doc(ProjectDoc, projectId, project)).sceneProfileId = profileId;
    }, context);
    return sceneProfile(projectId, sourceId);
  }
  async function prepareStepSelection(id: string, relativePath: string) {
    const meta = await metadata(id);
    const project = await visibleProject(meta.projectId);
    const file = relativePath ? await resolveStepPath(project.path, relativePath) : null;
    const source = file
      ? ((await findSource(project.id, file.relativePath)) ?? {
          id: crypto.randomUUID(),
          projectId: project.id,
          relativePath: file.relativePath,
        })
      : null;
    return {
      file,
      source,
      async commit(signal?: AbortSignal) {
        signal?.throwIfAborted();
        await harness.commit(async (tx) => {
          // The transaction has not committed while this callback is running, so an
          // abort here leaves both the conversation and project selection unchanged.
          signal?.throwIfAborted();
          if (source) await tx.doc(StepSourceDoc, source.id, source);
          (await tx.doc(ConversationDoc, conversationId(id))).selectedSourceId = source?.id ?? "";
          (await tx.doc(ProjectDoc, project.id, project)).currentSourceId = source?.id ?? "";
          signal?.throwIfAborted();
        }, context);
      },
    };
  }
  async function selectStep(id: string, relativePath: string) {
    await (await prepareStepSelection(id, relativePath)).commit();
    return metadata(id);
  }
  function requests({
    idle,
    defaultModel,
    watcher,
    display,
    publish,
  }: {
    idle(): void;
    defaultModel(): string;
    watcher: { currentId(): string | null; stop(): Promise<void> };
    display: Pick<Artifacts, "get">;
    publish(event: ApplicationEvent): void;
  }) {
    const changed = () => publish({ type: "workspace" });
    const handlers: Handlers<
      | "display.get"
      | "project.open"
      | "project.refresh"
      | "project.remove"
      | "conversation.create"
      | "conversation.update"
      | "conversation.selectStep"
      | "conversation.delete"
    > = {
      async "display.get"({ id }) {
        const meta = await metadata(id);
        const project = await visibleProject(meta.projectId);
        if (!meta.source) return null;
        const model = await display.get(meta.source.id);
        if (!model) return null;
        try {
          const source = await resolveStepPath(project.path, meta.source.relativePath);
          const current = await fileHash(source.path, 512 * 1024 * 1024);
          return {
            ...model,
            sourceStatus: current.sha256 === model.sourceHash ? "current" : "changed",
          };
        } catch {
          return { ...model, sourceStatus: "missing" };
        }
      },
      async "project.open"({ path }) {
        idle();
        const directory = await projectDirectory(path);
        const projects = await projectRecords();
        const samePath = (value: string) =>
          process.platform === "win32" ? value.toLowerCase() : value;
        const existing = projects.find(
          (project) => samePath(project.path) === samePath(directory.path),
        );
        if (existing) {
          if (existing.hidden) {
            if (projects.filter((project) => !project.hidden).length >= 100)
              throw new Error("最多可打开 100 个项目，请先移除其他项目。");
            await harness.commit(async (tx) => {
              (await tx.doc(ProjectDoc, existing.id, existing)).hidden = false;
            }, context);
            changed();
          }
          return projectFiles(existing);
        }
        if (projects.filter((project) => !project.hidden).length >= 100)
          throw new Error("最多可打开 100 个项目，请先移除其他项目。");
        const project = { id: crypto.randomUUID(), ...directory };
        await harness.commit(async (tx) => {
          await tx.doc(ProjectDoc, project.id, project);
        }, context);
        changed();
        return projectFiles(project);
      },
      async "project.refresh"({ id }) {
        return projectFiles(await visibleProject(id));
      },
      async "project.remove"({ id }) {
        idle();
        const project = await harness.snapshot(ProjectDoc, id, context);
        if (!project) throw new Error("项目不存在。");
        if (project.hidden) return null;
        await harness.commit(async (tx) => {
          (await tx.doc(ProjectDoc, id, project)).hidden = true;
        }, context);
        const watchedId = watcher.currentId();
        if (watchedId && (await metadata(watchedId)).projectId === id) await watcher.stop();
        changed();
        return null;
      },
      async "conversation.create"({ projectId }) {
        idle();
        const project = await visibleProject(projectId);
        const conversation = await harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            init: async (tx, id) => {
              Object.assign(await tx.doc(ConversationDoc, id), {
                id: String(id),
                projectId,
                modelId: defaultModel(),
                selectedSourceId: project.currentSourceId ?? "",
              });
            },
          },
          context,
        );
        changed();
        return metadata(String(conversation.id));
      },
      async "conversation.update"({ id, thinkingLevel, ...change }) {
        const current = await metadata(id);
        if (
          change.mode !== undefined ||
          change.archived !== undefined ||
          change.modelId !== undefined ||
          thinkingLevel !== undefined
        )
          idle();
        await harness.commit(async (tx) => {
          Object.assign(await tx.doc(ConversationDoc, conversationId(id)), change);
          if (thinkingLevel !== undefined || change.modelId !== undefined) {
            const model = modelFor(change.modelId ?? current.modelId);
            const requested = thinkingLevel ?? current.thinkingLevel ?? "off";
            if (
              thinkingLevel !== undefined &&
              (!model || clampThinkingLevel(model, requested) !== requested)
            )
              throw new Error("当前模型不支持所选推理档位。");
            await configure(tx, conversationId(id), {
              thinkingLevel: model ? clampThinkingLevel(model, requested) : "off",
            });
          }
        }, context);
        if (thinkingLevel !== undefined || Object.keys(change).some((key) => key !== "draft"))
          changed();
        return metadata(id);
      },
      async "conversation.selectStep"({ id, relativePath }) {
        idle();
        const result = await selectStep(id, relativePath);
        changed();
        return result;
      },
      async "conversation.delete"({ id }) {
        idle();
        const value = await harness.snapshot(ConversationDoc, conversationId(id), context);
        if (!value) throw new Error("对话不存在。");
        if (value.deletedAt) return null;
        await harness.commit(async (tx) => {
          (await tx.doc(ConversationDoc, conversationId(id))).deletedAt = new Date().toISOString();
        }, context);
        if (watcher.currentId() === id) await watcher.stop();
        publish({ type: "conversationDeleted", id });
        changed();
        return null;
      },
    };
    return handlers;
  }
  return {
    records: projectRecords,
    visible: visibleProject,
    metadata,
    conversation: getConversation,
    sceneProfile,
    setSceneProfile,
    prepareStepSelection,
    selectStep,
    requests,
  };
}
export type Projects = ReturnType<typeof createProjects>;
