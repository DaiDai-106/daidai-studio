import { randomUUID } from "node:crypto";
import { contentText } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  ApplicationEvent,
  ConversationInfo,
  ConversationView,
  DeliveryMode,
} from "../../contracts/application.ts";
import type { PackageLoad, PluginModule } from "../../contracts/catalog.ts";
import { createCodingFileService } from "../coding/file_service.ts";
import { resolveFileReferences } from "../coding/references.ts";
import { createPackageService } from "../extensions/package_service.ts";
import { createSkillService } from "../extensions/skill_service.ts";
import type { openProjectStore, QueuedMessage, StoredConversation } from "../projects/store.ts";
import type { createSettingsService } from "../settings/service.ts";
import { conversationTitle } from "./conversation_title.ts";
import type { createExtensionUi } from "./extension_ui.ts";
import { createHistoryProjection } from "./history_projection.ts";
import { createPiAgent } from "./pi_agent.ts";
import { createPiHistory } from "./pi_history.ts";
import { projectTrace, traceDetail } from "./pi_trace.ts";
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
  const queues = new Map<string, QueuedMessage[]>();
  const eligible = new Map<string, Set<string>>();
  const delivering = new Map<
    string,
    { id: string; text?: string | undefined; consumed?: boolean }
  >();
  const queued = (id: string) => {
    let items = queues.get(id);
    if (!items) {
      items = store.queuedMessages(id);
      queues.set(id, items);
    }
    return items;
  };
  function removeQueued(id: string, messageId: string) {
    store.removeQueuedMessage(id, messageId);
    queues.set(
      id,
      queued(id).filter((item) => item.id !== messageId),
    );
    eligible.get(id)?.delete(messageId);
    if (delivering.get(id)?.id === messageId) delivering.delete(id);
  }
  function nextQueued(id: string, allowFollowUp = true) {
    const available = queued(id).filter((item) => eligible.get(id)?.has(item.id));
    return (
      available.find((item) => item.delivery === "steer") ??
      (allowFollowUp ? available[0] : undefined)
    );
  }

  const imagesFor = (images: QueuedMessage["images"]) =>
    images?.map((image) => ({
      type: "image" as const,
      ...image,
    }));

  // 只在 Pi 等待下一次模型请求的边界投递，尚未投递的消息仍可独立取消。
  async function deliverQueued(id: string, session: AgentSession, final: boolean) {
    if (stopped.has(id) || delivering.has(id)) return;
    const item = nextQueued(id, final);
    if (!item) return;
    delivering.set(id, { id: item.id });
    emit(id);
    try {
      const text = await resolveFileReferences(
        codingFiles,
        requireConversation(id).projectId,
        item.text,
      );
      if (stopped.has(id)) return;
      const disposition = await session[item.delivery](text, imagesFor(item.images));
      const texts =
        item.delivery === "steer" ? session.getSteeringMessages() : session.getFollowUpMessages();
      if (disposition === "handled") removeQueued(id, item.id);
      else delivering.set(id, { id: item.id, text: texts.at(-1) });
      if (stopped.has(id)) session.clearQueue();
    } catch (error) {
      delivering.delete(id);
      eligible.delete(id);
      failures.set(id, (error instanceof Error ? error.message : "消息投递失败。").slice(0, 10000));
    }
    emit(id);
  }
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

  // 聊天和轨迹始终读取同一个运行时分支；空闲历史通过现有 SessionManager 缓存恢复。
  const managerFor = (id: string) => live.get(id)?.session.sessionManager ?? history.open(id);

  function view(id: string): ConversationView {
    const stored = requireConversation(id);
    const manager = managerFor(id);
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
      queuedMessages: queued(id).map((item) => ({
        id: item.id,
        text: item.text.slice(0, 1000),
        delivery: item.delivery,
        imageCount: item.images?.length ?? 0,
        delivering: delivering.get(id)?.id === item.id,
        paused: !eligible.get(id)?.has(item.id),
      })),
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
        partial.set(id, contentText(event.message.content, "").slice(0, 4_000_000));
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
    session.subscribe((event) => {
      // 图片归一化可能补充正文；以 SDK 出队事件确认投递，不比较归一化后的文本。
      if (event.type !== "queue_update") return;
      const pending = delivering.get(id);
      if (
        pending?.text !== undefined &&
        ![...event.steering, ...event.followUp].includes(pending.text)
      ) {
        pending.consumed = true;
      }
    });
    session.setSteeringMode("one-at-a-time");
    session.setFollowUpMode("one-at-a-time");
    session.agent.subscribe(async (event) => {
      if (event.type === "message_end" && event.message.role === "user") {
        const pending = delivering.get(id);
        if (pending && (pending.text === undefined || pending.consumed)) {
          // Core 的异步监听器运行时，SDK 已将用户消息追加到原生历史。
          removeQueued(id, pending.id);
          emit(id);
        }
      }
      if (
        event.type === "turn_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason !== "error" &&
        event.message.stopReason !== "aborted"
      ) {
        await deliverQueued(
          id,
          session,
          !event.message.content.some((block) => block.type === "toolCall"),
        );
      }
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
        stopped.add(id);
        item.session.clearQueue();
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

    trace(id: string) {
      requireConversation(id);
      return projectTrace(managerFor(id).getBranch());
    },

    traceDetail(id: string, entryId: string) {
      requireConversation(id);
      return traceDetail(managerFor(id).getBranch(), entryId);
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
      images?: import("../../contracts/application.ts").ChatImage[];
      delivery?: DeliveryMode;
      queuedId?: string;
    }) {
      if (!input.text.trim() && !input.images?.length) throw new Error("请输入消息。");
      if (busy.has(input.id)) {
        if (!input.delivery) throw new Error("此会话正在运行，请选择插话或完成后发送。");
        if (stopped.has(input.id)) throw new Error("会话正在停止，请稍后再发送。");
        if (queued(input.id).length >= 20) throw new Error("最多保留 20 条待处理消息。");
        const item = {
          id: input.requestId,
          text: input.text,
          delivery: input.delivery,
          ...(input.images?.length ? { images: input.images } : {}),
        };
        store.queueMessage(input.id, item);
        queued(input.id).push(item);
        const ready = eligible.get(input.id) ?? new Set<string>();
        ready.add(input.requestId);
        eligible.set(input.id, ready);
        store.updateConversation(input.id, { draft: "" });
        emit(input.id);
        return { submissionId: input.requestId };
      }
      const conversation = requireConversation(input.id);
      let message = input.text;
      // 在第一次 await 之前占位，防止并发请求创建两个 Pi 会话并覆盖 JSONL。
      options.extensionUi?.beginConversation(input.id);
      let releaseReservation!: () => void;
      const reservation = new Promise<void>((resolve) => {
        releaseReservation = resolve;
      });
      busy.set(input.id, reservation);
      if (input.queuedId) delivering.set(input.id, { id: input.queuedId });
      let session: AgentSession;
      try {
        message = await resolveFileReferences(codingFiles, conversation.projectId, message);
        session = await agent(input.id);
      } catch (error) {
        busy.delete(input.id);
        stopped.delete(input.id);
        eligible.delete(input.id);
        delivering.delete(input.id);
        releaseReservation();
        emit(input.id);
        throw error;
      }
      failures.delete(input.id);
      const current = requireConversation(input.id);
      store.updateConversation(input.id, {
        interrupted: true,
        ...(!input.queuedId ? { draft: "" } : {}),
        ...(!current.hasMessages && current.title === "新会话"
          ? { title: conversationTitle(input.text) }
          : {}),
      });
      const work = Promise.resolve().then(async () => {
        try {
          let queuedId = input.queuedId;
          let images = input.images;
          while (!stopped.has(input.id) && !failures.has(input.id)) {
            await session.prompt(message, {
              ...(images ? { images: imagesFor(images) ?? [] } : {}),
              preflightResult: (disposition) => {
                if (queuedId && disposition === "handled") removeQueued(input.id, queuedId);
              },
            });
            const outcome = session.messages.at(-1);
            if (
              outcome?.role === "assistant" &&
              (outcome.stopReason === "error" || outcome.stopReason === "aborted")
            )
              break;
            // 覆盖发送恰好落在最后一个 turn_end 之后的竞态，不启动并行运行。
            const next = nextQueued(input.id);
            if (!next || stopped.has(input.id) || failures.has(input.id)) break;
            queuedId = next.id;
            images = next.images;
            delivering.set(input.id, { id: queuedId });
            emit(input.id);
            message = await resolveFileReferences(
              codingFiles,
              requireConversation(input.id).projectId,
              next.text,
            );
          }
        } catch (error) {
          failures.set(
            input.id,
            (error instanceof Error ? error.message : "会话执行失败。").slice(0, 10_000),
          );
        } finally {
          session.clearQueue();
          eligible.delete(input.id);
          delivering.delete(input.id);
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
      live.get(id)?.session.clearQueue();
      await live.get(id)?.session.abort();
      return null;
    },

    cancelQueued(id: string, messageId: string) {
      requireConversation(id);
      if (delivering.get(id)?.id === messageId) throw new Error("这条消息正在投递，无法取消。");
      removeQueued(id, messageId);
      emit(id);
      return null;
    },

    promoteQueued(id: string, messageId: string) {
      requireConversation(id);
      if (!busy.has(id) || stopped.has(id)) throw new Error("当前会话未运行，请点击继续发送。");
      if (delivering.get(id)?.id === messageId) throw new Error("这条消息正在投递，无法改为插话。");
      const item = queued(id).find((message) => message.id === messageId);
      if (!item) throw new Error("这条消息已投递或取消。");
      if (!eligible.get(id)?.has(messageId)) throw new Error("这条消息已暂停，请稍后继续发送。");
      store.promoteQueuedMessage(id, messageId);
      item.delivery = "steer";
      emit(id);
      return null;
    },

    async resumeQueue(id: string) {
      requireConversation(id);
      if (busy.has(id)) throw new Error("请先等待当前运行结束。");
      eligible.set(id, new Set(queued(id).map((item) => item.id)));
      const first = nextQueued(id);
      if (!first) {
        eligible.delete(id);
        return null;
      }
      try {
        await this.send({
          id,
          requestId: first.id,
          text: first.text,
          ...(first.images ? { images: first.images } : {}),
          queuedId: first.id,
        });
      } catch (error) {
        eligible.delete(id);
        throw error;
      }
      return null;
    },

    async remove(id: string) {
      requireConversation(id);
      await release(id);
      history.forget(id);
      store.deleteConversation(id);
      queues.delete(id);
      eligible.delete(id);
      delivering.delete(id);
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
