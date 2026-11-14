import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  ApplicationEvent,
  ConversationInfo,
  ConversationView,
} from "../../contracts/application.ts";
import type { PackageLoad, PluginModule } from "../../contracts/catalog.ts";
import { createCodingFileService } from "../coding/file_service.ts";
import { resolveFileReferences } from "../coding/references.ts";
import { createPackageService } from "../extensions/package_service.ts";
import { createSkillService } from "../extensions/skill_service.ts";
import type { openProjectStore, StoredConversation } from "../projects/store.ts";
import type { createSettingsService } from "../settings/service.ts";
import { conversationTitle } from "./conversation_title.ts";
import type { createExtensionUi } from "./extension_ui.ts";
import { createHistoryProjection } from "./history_projection.ts";
import { createPiAgent } from "./pi_agent.ts";
import { createPiHistory } from "./pi_history.ts";
import type { createShellApproval } from "./shell_approval.ts";

type Settings = Awaited<ReturnType<typeof createSettingsService>>;
type Live = {
  session: AgentSession;
  projectId: string;
};

export function createConversations(options: {
  onPackageLoad?: (moduleId: PluginModule, entries: PackageLoad[]) => void;
  dataRoot: string;
  store: ReturnType<typeof openProjectStore>;
  settings: Settings;
  publish: (event: ApplicationEvent) => void;
  shellApproval?: ReturnType<typeof createShellApproval>;
  extensionUi?: ReturnType<typeof createExtensionUi>;
}) {
  const { dataRoot, store, settings, publish } = options;
  const history = createPiHistory(store, dataRoot);
  const live = new Map<string, Live>();
  const busy = new Map<string, Promise<void>>();
  const stopped = new Set<string>();
  const streamId = randomUUID();
  const sequences = new Map<string, number>();
  const partial = new Map<string, string>();
  const partialBlocks = new Map<string, NonNullable<ConversationView["partialBlocks"]>>();
  const failures = new Map<string, string>();
  const activeTools = new Map<string, Map<string, ConversationView["activeTools"][number]>>();
  const userSkills = createSkillService({ dataRoot });
  const codingFiles = createCodingFileService(store);
  const projectHistory = createHistoryProjection((provider, model) =>
    settings.modelRuntime.getModel(provider, model),
  );
  const pendingProgress = new Map<string, ReturnType<typeof setTimeout>>();

  function metadata(conversation: StoredConversation): ConversationInfo {
    const project = store.getProject(conversation.projectId);
    if (!project) throw new Error("项目不存在。");

    return {
      id: conversation.id,
      projectId: project.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      mode: project.mode,
      modelId: conversation.modelId,
      thinkingLevel: conversation.thinkingLevel,
      accessMode: conversation.accessMode,
      draft: conversation.draft,
      archived: conversation.archived,
      interrupted: conversation.interrupted,
    };
  }

  function requireConversation(id: string) {
    const record = store.getConversation(id);
    if (!record) throw new Error("会话不存在。");
    return record;
  }

  function textContent(value: unknown): string {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value
      .map((item: unknown) => {
        if (!item || typeof item !== "object") return "";
        const block = item as { type?: string; text?: string };
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .join("");
  }

  function view(id: string): ConversationView {
    const stored = requireConversation(id);
    const manager = live.get(id)?.session.sessionManager ?? history.open(id);
    const session = live.get(id)?.session;
    const projected = projectHistory.get(
      manager,
      session ? () => session.getSessionStats() : undefined,
    );
    const firstUser = projected.messages.find((message) => message.role === "user");
    if (stored.title === "新会话" && firstUser) {
      store.updateConversation(id, { title: conversationTitle(firstUser.text) });
      publish({ type: "workspace" });
    }
    const tools = [...(activeTools.get(id)?.values() ?? [])];
    const blocks = partialBlocks.get(id);

    return {
      conversationId: id,
      streamId,
      sequence: sequences.get(id) ?? 0,
      messages: projected.messages,
      historyKey: projected.historyKey,
      partial: partial.get(id) ?? "",
      busy: busy.has(id),
      error: failures.get(id) ?? "",
      ...(blocks ? { partialBlocks: blocks } : {}),
      ...(busy.has(id)
        ? {
            activity: tools.length
              ? ("tools" as const)
              : partialBlocks.get(id)?.some((block) => block.kind === "thinking") &&
                  !partial.get(id)
                ? ("thinking" as const)
                : ("responding" as const),
          }
        : {}),
      usage: projected.usage,
      branchUsage: projected.branchUsage,
      latestResponse: projected.latestResponse,
      respondingModel: null,
      activeTools: tools,
    };
  }

  function cancelProgress(id: string) {
    clearTimeout(pendingProgress.get(id));
    pendingProgress.delete(id);
  }

  function emit(id: string) {
    cancelProgress(id);
    sequences.set(id, (sequences.get(id) ?? 0) + 1);
    publish({ type: "conversation", view: view(id) });
  }

  // 只合并高频更新；提交、工具开始/结束、停止及失败立即发送完整快照。
  function scheduleProgress(id: string) {
    if (pendingProgress.has(id)) return;
    pendingProgress.set(
      id,
      setTimeout(() => {
        pendingProgress.delete(id);
        if (!live.has(id)) return;
        sequences.set(id, (sequences.get(id) ?? 0) + 1);
        const { messages: _messages, ...progress } = view(id);
        publish({ type: "conversation.progress", view: progress });
      }, 50),
    );
  }

  async function agent(id: string): Promise<AgentSession> {
    const previous = live.get(id);
    if (previous) return previous.session;
    const conversation = requireConversation(id);
    const project = store.getProject(conversation.projectId);
    if (!project) throw new Error("项目不存在。");

    const selection = conversation.modelId || (await settings.info()).defaultModel;
    const model = settings.model(selection);
    if (!model) throw new Error("请先在设置中配置并选择模型。");

    const skills = await userSkills.list();
    const session = await createPiAgent({
      conversationId: id,
      onPackageLoad: (entries) => options.onPackageLoad?.(project.mode, entries),
      cwd: project.path,
      dataRoot,
      history,
      packages: createPackageService({ dataRoot, moduleId: project.mode }),
      modelRuntime: settings.modelRuntime,
      ...(options.extensionUi ? { uiContext: options.extensionUi.context(id) } : {}),
      fullAccess: () => store.getConversation(id)?.accessMode === "full",
      ...(options.shellApproval
        ? {
            shellApproval: options.shellApproval.extension(
              id,
              () => store.getConversation(id)?.accessMode === "full",
            ),
          }
        : {}),
      model,
      skillPaths: skills.skills.map((skill) => skill.filePath),
    });
    session.setThinkingLevel(conversation.thinkingLevel);
    session.subscribe((event) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        partial.set(id, textContent(event.message.content).slice(0, 4_000_000));
        partialBlocks.set(
          id,
          event.message.content.flatMap<NonNullable<ConversationView["partialBlocks"]>[number]>(
            (block) => {
              if (block.type === "text")
                return [{ kind: "text" as const, text: block.text.slice(0, 4_000_000) }];
              if (block.type === "thinking" && !block.redacted)
                return [{ kind: "thinking" as const, text: block.thinking.slice(0, 4_000_000) }];
              return [];
            },
          ),
        );
        scheduleProgress(id);
        return;
      }
      if (event.type === "tool_execution_update") {
        scheduleProgress(id);
        return;
      }
      if (event.type === "message_end") {
        // Pi 先通知 message_end，随后同步追加 JSONL。等落盘后再切换到历史投影，避免短暂空帧。
        queueMicrotask(() => {
          const conversation = store.getConversation(id);
          if (!conversation || !live.has(id)) return;
          partial.delete(id);
          partialBlocks.delete(id);
          if (session.sessionManager.isPersisted() && !conversation.hasMessages)
            store.updateConversation(id, { hasMessages: true });
          emit(id);
        });
        return;
      }
      if (event.type === "tool_execution_start") {
        const running = activeTools.get(id) ?? new Map();
        running.set(event.toolCallId, {
          id: event.toolCallId.slice(0, 200),
          name: event.toolName.slice(0, 200),
          phase: "执行中",
          status: "running",
        });
        activeTools.set(id, running);
      }
      if (event.type === "tool_execution_end") activeTools.get(id)?.delete(event.toolCallId);
      emit(id);
    });
    live.set(id, { session, projectId: project.id });
    return session;
  }

  async function release(id: string) {
    const item = live.get(id);
    if (!item) return;
    options.extensionUi?.cancelConversation(id);
    try {
      if (busy.has(id)) {
        await item.session.abort();
        await busy.get(id);
      }
    } finally {
      cancelProgress(id);
      live.delete(id);
      try {
        await item.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        item.session.dispose();
      }
    }
  }

  return {
    metadata,
    list(projectId: string) {
      return store.listConversations(projectId).map(metadata);
    },

    async create(projectId: string) {
      const item = store.createConversation(projectId, (await settings.info()).defaultModel);
      publish({ type: "workspace" });
      return metadata(item);
    },

    fork(id: string) {
      if (busy.has(id)) throw new Error("请先停止当前会话再分叉。");
      const result = metadata(history.fork(id));
      publish({ type: "workspace" });
      return result;
    },

    async update(input: {
      id: string;
      title?: string;
      modelId?: string;
      thinkingLevel?: NonNullable<ConversationInfo["thinkingLevel"]>;
      accessMode?: NonNullable<ConversationInfo["accessMode"]>;
      draft?: string;
      archived?: boolean;
    }) {
      const old = requireConversation(input.id);
      const project = store.getProject(old.projectId);
      if (!project) throw new Error("会话模式由项目决定，不能单独更改。");
      if (
        busy.has(input.id) &&
        (input.modelId !== undefined ||
          input.thinkingLevel !== undefined ||
          input.accessMode !== undefined)
      )
        throw new Error("请先停止当前会话。");
      const { id, ...update } = input;
      if (
        (update.modelId !== undefined && update.modelId !== old.modelId) ||
        (update.thinkingLevel !== undefined && update.thinkingLevel !== old.thinkingLevel)
      )
        await release(id);
      const result = metadata(store.updateConversation(id, update));
      publish({ type: "workspace" });
      return result;
    },
    watch: view,
    busyId() {
      return busy.keys().next().value ?? null;
    },

    async send(input: {
      id: string;
      requestId: string;
      text: string;
      images?: { mimeType: string; data: string }[];
    }) {
      if (busy.has(input.id)) throw new Error("此会话正在运行。");
      if (!input.text.trim() && !input.images?.length) throw new Error("请输入消息。");
      const conversation = requireConversation(input.id);
      let message = input.text;
      // 在第一次 await 之前占位，防止并发请求创建两个 Pi 会话并覆盖 JSONL。
      options.extensionUi?.beginConversation(input.id);
      let releaseReservation!: () => void;
      const reservation = new Promise<void>((resolve) => {
        releaseReservation = resolve;
      });
      busy.set(input.id, reservation);
      let session: AgentSession;
      try {
        message = await resolveFileReferences(codingFiles, conversation.projectId, message);
        session = await agent(input.id);
      } catch (error) {
        busy.delete(input.id);
        stopped.delete(input.id);
        releaseReservation();
        throw error;
      }
      failures.delete(input.id);
      const current = requireConversation(input.id);
      store.updateConversation(input.id, {
        interrupted: true,
        draft: "",
        ...(!current.hasMessages && current.title === "新会话"
          ? { title: conversationTitle(input.text) }
          : {}),
      });
      const work = Promise.resolve().then(async () => {
        try {
          if (stopped.has(input.id)) return;
          await session.prompt(message, {
            ...(input.images?.length
              ? {
                  images: input.images.map((image) => ({
                    type: "image" as const,
                    mimeType: image.mimeType,
                    data: image.data,
                  })),
                }
              : {}),
          });
        } catch (error) {
          failures.set(
            input.id,
            (error instanceof Error ? error.message : "会话执行失败。").slice(0, 10_000),
          );
        } finally {
          store.updateConversation(input.id, { interrupted: false });
          busy.delete(input.id);
          stopped.delete(input.id);
          partial.delete(input.id);
          partialBlocks.delete(input.id);
          activeTools.delete(input.id);
          emit(input.id);
          publish({ type: "workspace" });
        }
      });
      busy.set(input.id, work);
      releaseReservation();
      emit(input.id);
      return { submissionId: input.requestId };
    },

    async stop(id: string) {
      requireConversation(id);
      if (busy.has(id)) stopped.add(id);
      options.extensionUi?.cancelConversation(id);
      await live.get(id)?.session.abort();
      return null;
    },

    async remove(id: string) {
      requireConversation(id);
      await release(id);
      history.forget(id);
      store.deleteConversation(id);
      publish({ type: "conversationDeleted", id });
      publish({ type: "workspace" });
      return null;
    },

    async invalidate(projectId?: string, moduleId?: PluginModule) {
      const matches = (id: string) => {
        const owner = live.get(id)?.projectId ?? store.getConversation(id)?.projectId;
        return (
          (!projectId || owner === projectId) &&
          (!moduleId || store.getProject(owner ?? "")?.mode === moduleId)
        );
      };
      const ids = [...live.keys()].filter(matches);
      if ([...busy.keys()].some(matches)) throw new Error("请先停止相关会话。");
      projectHistory.clear();
      for (const id of ids) await release(id);
    },

    async close() {
      const results = await Promise.allSettled([...live.keys()].map(release));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "部分会话未能正常关闭。");
    },
  };
}
