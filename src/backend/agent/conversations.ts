import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  ApplicationEvent,
  Arguments,
  ConversationInfo,
  ConversationView,
} from "../../contracts/application.ts";
import type { PackageLoad, PluginModule } from "../../contracts/catalog.ts";
import { splitChatAttachment, stepMessage, zipMessage } from "../../shared/chat_attachment.ts";
import { isPlanningZipFile } from "../../shared/planning_zip.ts";
import type { BuiltinMcpConnection } from "../extensions/mcp/extension.ts";
import { createPackageService } from "../extensions/package_service.ts";
import { createSkillService } from "../extensions/skill_service.ts";
import { createCodingFileService } from "../module/coding/file_service.ts";
import { resolveFileReferences } from "../module/coding/references.ts";
import type { createPlanningService } from "../module/planning/service.ts";
import type { createSceneService } from "../module/scene/service.ts";
import type { openProjectStore, QueuedMessage, StoredConversation } from "../projects/store.ts";
import type { createSettingsService } from "../settings/service.ts";
import { conversationTitle } from "./conversation_title.ts";
import type { createExtensionUi } from "./extension_ui.ts";
import { createHistoryProjection } from "./history_projection.ts";
import { createAgentModuleConfig } from "./module_config.ts";
import { createPiAgent } from "./pi_agent.ts";
import { createPiHistory } from "./pi_history.ts";
import { projectTrace, traceDetail } from "./pi_trace.ts";
import type { createShellApproval } from "./shell_approval.ts";

type Settings = Awaited<ReturnType<typeof createSettingsService>>;
const cancelledSend = () => new Error("发送已取消，消息未提交。");
type ConversationRun = {
  done: Promise<void>;
  stopped: boolean;
  // Pi 接手输入后清除回调，之后的错误属于运行本身。
  acceptSubmission?: () => void;
};
type ConversationRuntime = {
  session?: AgentSession;
  run?: ConversationRun;
  preparing?: { controller: AbortController; done: Promise<void> };
  queue?: QueuedMessage[];
  eligible?: Set<string>;
  delivery?: { id: string; text?: string | undefined; consumed?: boolean };
  sequence: number;
  partial?: string;
  partialBlocks?: NonNullable<ConversationView["partialBlocks"]>;
  error?: string;
  tools?: Map<string, ConversationView["activeTools"][number]>;
  progressTimer?: ReturnType<typeof setTimeout>;
};

export function createConversations(options: {
  onPackageLoad?: (moduleId: PluginModule, entries: PackageLoad[]) => void;
  dataRoot: string;
  store: ReturnType<typeof openProjectStore>;
  settings: Settings;
  codingFiles?: ReturnType<typeof createCodingFileService>;
  scene?: ReturnType<typeof createSceneService>;
  planning?: ReturnType<typeof createPlanningService>;
  builtinMcp?: (id: string) => BuiltinMcpConnection | undefined;
  protectedPrivateKeys?: ReadonlySet<string> | undefined;
  publish: (event: ApplicationEvent) => void;
  shellApproval?: ReturnType<typeof createShellApproval>;
  extensionUi?: ReturnType<typeof createExtensionUi>;
}) {
  const { dataRoot, store, settings, publish } = options;
  const history = createPiHistory(store, dataRoot);
  const sessions = new Map<string, ConversationRuntime>();
  const isBusy = (state?: ConversationRuntime) => Boolean(state?.run || state?.preparing);
  function runtime(id: string) {
    const existing = sessions.get(id);
    if (existing) return existing;
    const state: ConversationRuntime = { sequence: 0 };
    sessions.set(id, state);
    return state;
  }
  function queued(id: string, state: ConversationRuntime) {
    state.queue ??= store.queuedMessages(id);
    return state.queue;
  }

  function removeQueued(id: string, messageId: string) {
    const state = runtime(id);
    store.removeQueuedMessage(id, messageId);
    state.queue = queued(id, state).filter((item) => item.id !== messageId);
    state.eligible?.delete(messageId);
    if (state.delivery?.id === messageId) delete state.delivery;
  }

  async function discardStepAttachment(projectId: string, id: string) {
    await options.scene
      ?.removeStepAttachment(projectId, id)
      .catch((error) => console.error("Failed to discard an unsent STEP attachment.", error));
  }
  function nextQueued(id: string, state: ConversationRuntime, allowFollowUp = true) {
    const available = queued(id, state).filter((item) => state.eligible?.has(item.id));
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
    const state = runtime(id);
    const run = state.run;
    if (!run || run.stopped || state.delivery) return;
    const item = nextQueued(id, state, final);
    if (!item) return;
    state.delivery = { id: item.id };
    emit(id);
    try {
      const text = await resolveMessage(requireConversation(id).projectId, item.text);
      if (run.stopped) return;
      const disposition = await session[item.delivery](text, imagesFor(item.images));
      const texts =
        item.delivery === "steer" ? session.getSteeringMessages() : session.getFollowUpMessages();
      if (disposition === "handled") removeQueued(id, item.id);
      else state.delivery = { id: item.id, text: texts.at(-1) };
      if (run.stopped) session.clearQueue();
    } catch (error) {
      delete state.delivery;
      delete state.eligible;
      state.error = (error instanceof Error ? error.message : "消息投递失败。").slice(0, 10_000);
    }
    emit(id);
  }
  const streamId = randomUUID();
  const userSkills = createSkillService({ dataRoot });
  const codingFiles = options.codingFiles ?? createCodingFileService(store);
  const projectHistory = createHistoryProjection((provider, model) =>
    settings.modelRuntime.getModel(provider, model),
  );

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
      // 正在运行时也会落盘恢复标记，仅在没有运行时显示中断提示。
      interrupted: conversation.interrupted && !isBusy(sessions.get(conversation.id)),
    };
  }

  function requireConversation(id: string) {
    const record = store.getConversation(id);
    if (!record) throw new Error("会话不存在。");
    return record;
  }

  function resolveMessage(projectId: string, text: string) {
    return store.getProject(projectId)?.mode === "coding"
      ? resolveFileReferences(codingFiles, projectId, text)
      : text;
  }

  // 聊天和轨迹始终读取同一个运行时分支；空闲历史通过现有 SessionManager 缓存恢复。
  const managerFor = (id: string) => sessions.get(id)?.session?.sessionManager ?? history.read(id);

  function view(id: string): ConversationView {
    requireConversation(id);
    const state = runtime(id);
    const manager = managerFor(id);
    const session = state.session;
    const projected = projectHistory.get(
      manager,
      session ? () => session.getSessionStats() : undefined,
    );
    const tools = [...(state.tools?.values() ?? [])];
    const blocks = state.partialBlocks;

    return {
      conversationId: id,
      streamId,
      sequence: state.sequence,
      messages: projected.messages,
      history: projected.history,
      historyKey: projected.historyKey,
      partial: state.partial ?? "",
      queuedMessages: queued(id, state).map((item) => {
        const { text, ...attachment } = splitChatAttachment(item.text);
        return {
          id: item.id,
          text: text.slice(0, 1000),
          ...attachment,
          delivery: item.delivery,
          imageCount: item.images?.length ?? 0,
          delivering: state.delivery?.id === item.id,
          paused: !state.eligible?.has(item.id),
        };
      }),
      busy: isBusy(state),
      error: state.error ?? "",
      ...(blocks ? { partialBlocks: blocks } : {}),
      ...(state.run
        ? {
            activity: tools.length
              ? ("tools" as const)
              : blocks?.some((block) => block.kind === "thinking") && !state.partial
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

  function cancelProgress(state: ConversationRuntime) {
    clearTimeout(state.progressTimer);
    delete state.progressTimer;
  }

  function emit(id: string) {
    const state = runtime(id);
    cancelProgress(state);
    state.sequence++;
    publish({ type: "conversation", view: view(id) });
  }

  // 只合并高频更新；提交、工具开始/结束、停止及失败立即发送完整快照。
  function scheduleProgress(id: string) {
    const state = runtime(id);
    if (state.progressTimer !== undefined) return;
    state.progressTimer = setTimeout(() => {
      delete state.progressTimer;
      if (!state.session) return;
      state.sequence++;
      const { messages: _messages, history: _history, ...progress } = view(id);
      publish({ type: "conversation.progress", view: progress });
    }, 50);
  }

  async function agent(id: string): Promise<AgentSession> {
    const state = runtime(id);
    if (state.session) return state.session;
    const conversation = requireConversation(id);
    const project = store.getProject(conversation.projectId);
    if (!project) throw new Error("项目不存在。");

    const selection = conversation.modelId || settings.defaultModel;
    const model = settings.model(selection);
    if (!model) throw new Error("请先在设置中配置并选择模型。");

    const skills = await userSkills.list();
    const fullAccess = () => store.getConversation(id)?.accessMode === "full";
    const moduleConfig = createAgentModuleConfig(
      { project, conversationId: id, fullAccess },
      options,
    );
    const processServer = project.mode === "planning" ? store.getPlanningProcess(project.id) : null;
    const session = await createPiAgent({
      conversationId: id,
      onPackageLoad: (entries) => options.onPackageLoad?.(project.mode, entries),
      cwd: project.path,
      dataRoot,
      history,
      packages: createPackageService({ dataRoot, moduleId: project.mode }),
      modelRuntime: settings.modelRuntime,
      moduleConfig,
      processServer,
      builtinMcp: processServer ? options.builtinMcp?.(processServer) : undefined,
      protectedPrivateKeys: options.protectedPrivateKeys,
      beforePrompt() {
        if (state.run?.stopped) throw cancelledSend();
        state.run?.acceptSubmission?.();
      },
      ...(options.extensionUi ? { uiContext: options.extensionUi.context(id) } : {}),
      model,
      skillPaths: skills.skills.map((skill) => skill.filePath),
    });
    session.setThinkingLevel(conversation.thinkingLevel);
    session.subscribe((event) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        state.partial = contentText(event.message.content, "").slice(0, 4_000_000);
        state.partialBlocks = event.message.content.flatMap<
          NonNullable<ConversationView["partialBlocks"]>[number]
        >((block) => {
          if (block.type === "text")
            return [{ kind: "text" as const, text: block.text.slice(0, 4_000_000) }];
          if (block.type === "thinking" && !block.redacted)
            return [{ kind: "thinking" as const, text: block.thinking.slice(0, 4_000_000) }];
          return [];
        });
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
          if (!conversation || state.session !== session) return;
          delete state.partial;
          delete state.partialBlocks;
          if (session.sessionManager.isPersisted() && !conversation.hasMessages) {
            try {
              store.updateConversation(id, { hasMessages: true });
            } catch (error) {
              state.error = (error instanceof Error ? error.message : "会话保存失败。").slice(
                0,
                10_000,
              );
            }
          }
          emit(id);
        });
        return;
      }
      if (event.type === "tool_execution_start") {
        state.tools ??= new Map();
        state.tools.set(event.toolCallId, {
          id: event.toolCallId.slice(0, 200),
          name: event.toolName.slice(0, 200),
          phase: "执行中",
          status: "running",
        });
      }
      if (event.type === "tool_execution_end") state.tools?.delete(event.toolCallId);
      emit(id);
    });
    session.subscribe((event) => {
      // 图片归一化可能补充正文；以 SDK 出队事件确认投递，不比较归一化后的文本。
      if (event.type !== "queue_update") return;
      const pending = state.delivery;
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
        const pending = state.delivery;
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
    state.session = session;
    return session;
  }

  function requestStop(id: string, run?: ConversationRun, session?: AgentSession) {
    if (run) run.stopped = true;
    options.extensionUi?.cancelConversation(id);
    session?.clearQueue();
    return session?.abort();
  }

  async function release(id: string) {
    const state = sessions.get(id);
    if (!state) return;
    const run = state.run;
    const preparing = state.preparing;
    preparing?.controller.abort(cancelledSend());
    try {
      await requestStop(id, run, run ? state.session : undefined);
      await run?.done;
      await preparing?.done;
    } finally {
      cancelProgress(state);
      const session = state.session;
      delete state.session;
      if (session) {
        try {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          session.dispose();
        }
      }
    }
  }

  async function submitMessage(
    input: Omit<Arguments<"conversation.send">, "stepPath" | "zipPath"> & {
      queuedId?: string;
      stepAttachmentId?: string;
    },
    conversation: StoredConversation,
    state: ConversationRuntime,
  ): Promise<{ submissionId: string }> {
    const { id } = conversation;
    if (state.run) {
      if (!input.delivery) throw new Error("此会话正在运行，请选择插话或完成后发送。");
      if (state.run.stopped) throw new Error("会话正在停止，请稍后再发送。");
      const queue = queued(id, state);
      if (queue.length >= 20) throw new Error("最多保留 20 条待处理消息。");
      const item = {
        id: input.requestId,
        text: input.text,
        delivery: input.delivery,
        ...(input.images?.length ? { images: input.images } : {}),
        ...(input.stepAttachmentId ? { stepAttachmentId: input.stepAttachmentId } : {}),
      };
      store.queueMessage(id, item, conversation.draft);
      queue.push(item);
      state.eligible ??= new Set();
      state.eligible.add(input.requestId);
      emit(id);
      return { submissionId: input.requestId };
    }
    let message = input.text;
    options.extensionUi?.beginConversation(id);
    const finished = Promise.withResolvers<void>();
    // 启动、执行和清理共用同一个占位，退出可以等待整个生命周期。
    const run: ConversationRun = { done: finished.promise, stopped: false };
    state.run = run;
    function finishRun() {
      cancelProgress(state);
      delete state.run;
      delete state.eligible;
      delete state.delivery;
      delete state.partial;
      delete state.partialBlocks;
      delete state.tools;
      finished.resolve();
      emit(id);
      publish({ type: "workspace" });
    }
    function checkStartup() {
      if (run.stopped) throw cancelledSend();
    }

    let session: AgentSession;
    try {
      publish({ type: "workspace" });
      if (input.queuedId) state.delivery = { id: input.queuedId };
      message = await resolveMessage(conversation.projectId, message);
      checkStartup();
      session = await agent(id);
      checkStartup();
      delete state.error;
      emit(id);
    } catch (error) {
      finishRun();
      throw error;
    }
    const submission = Promise.withResolvers<{ submissionId: string }>();
    run.acceptSubmission = () => {
      const current = requireConversation(id);
      store.updateConversation(id, {
        interrupted: true,
        // 插件等待确认时用户可能已经编辑了下一条草稿。
        ...(!input.queuedId && current.draft === conversation.draft ? { draft: "" } : {}),
        ...(!current.hasMessages && current.title === "新会话"
          ? { title: conversationTitle(input.text) }
          : {}),
      });
      delete run.acceptSubmission;
      submission.resolve({ submissionId: input.requestId });
      publish({ type: "workspace" });
    };
    void Promise.resolve()
      .then(async () => {
        try {
          let queuedId = input.queuedId;
          let images = input.images;
          while (!run.stopped && !state.error) {
            await session.prompt(message, {
              ...(images ? { images: imagesFor(images) ?? [] } : {}),
              preflightResult: (disposition) => {
                if (disposition !== "handled") return;
                checkStartup();
                run.acceptSubmission?.();
                if (queuedId) removeQueued(id, queuedId);
              },
            });
            if (run.acceptSubmission) throw new Error("Pi 未接受消息。");
            const outcome = session.messages.at(-1);
            if (
              outcome?.role === "assistant" &&
              (outcome.stopReason === "error" || outcome.stopReason === "aborted")
            )
              break;
            // 覆盖发送恰好落在最后一个 turn_end 之后的竞态，不启动并行运行。
            const next = nextQueued(id, state);
            if (!next || run.stopped || state.error) break;
            queuedId = next.id;
            images = next.images;
            state.delivery = { id: queuedId };
            emit(id);
            message = await resolveMessage(conversation.projectId, next.text);
          }
          if (run.acceptSubmission) throw cancelledSend();
        } catch (error) {
          if (run.acceptSubmission) submission.reject(run.stopped ? cancelledSend() : error);
          else if (!run.stopped)
            state.error = (error instanceof Error ? error.message : "会话执行失败。").slice(
              0,
              10_000,
            );
        } finally {
          try {
            session.clearQueue();
            if (!run.acceptSubmission) store.updateConversation(id, { interrupted: false });
          } catch (error) {
            state.error = (error instanceof Error ? error.message : "会话收尾失败。").slice(
              0,
              10_000,
            );
          } finally {
            finishRun();
          }
        }
      })
      .catch(() => console.error("Failed to publish final conversation state."));
    return submission.promise;
  }

  return {
    metadata,
    create(projectId: string) {
      const item = store.createConversation(projectId, settings.defaultModel);
      publish({ type: "workspace" });
      return metadata(item);
    },

    fork(id: string) {
      if (isBusy(sessions.get(id))) throw new Error("请先停止当前会话再分叉。");
      const result = metadata(history.fork(id));
      publish({ type: "workspace" });
      return result;
    },

    trace(id: string) {
      requireConversation(id);
      return projectTrace(managerFor(id)?.getBranch() ?? []);
    },

    traceDetail(id: string, entryId: string) {
      requireConversation(id);
      return traceDetail(managerFor(id)?.getBranch() ?? [], entryId);
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
        isBusy(sessions.get(input.id)) &&
        (input.modelId !== undefined ||
          input.thinkingLevel !== undefined ||
          input.accessMode !== undefined ||
          input.archived === true)
      )
        throw new Error("请先停止当前会话。");
      const { id, ...update } = input;
      if (update.title === "新会话" && old.hasMessages) {
        const text = projectHistory.firstUserText(managerFor(id));
        if (text !== undefined) update.title = conversationTitle(text);
      }
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
    readHistory(id: string, turnId: string, before = false) {
      requireConversation(id);
      return projectHistory.read(managerFor(id), turnId, before);
    },
    busyIds() {
      return [...sessions].flatMap(([id, state]) => (isBusy(state) ? [id] : []));
    },

    async send(input: Arguments<"conversation.send">): Promise<{ submissionId: string }> {
      const { stepPath, zipPath, ...message } = input;
      if (!input.text.trim() && !input.images?.length && !stepPath && !zipPath)
        throw new Error("请输入消息。");
      if (stepPath && zipPath) throw new Error("每条消息只能附加一个文件。");
      const id = input.id;
      const conversation = requireConversation(id);
      const state = runtime(id);
      if (state.preparing) throw new Error("正在读取 STEP 附件。");
      if (zipPath) {
        if (store.getProject(conversation.projectId)?.mode !== "planning")
          throw new Error("只有规划对话可以附加 ZIP 文件。");
        if (!isAbsolute(zipPath) || !isPlanningZipFile(zipPath) || zipPath.includes("\0"))
          throw new Error("请选择本机 ZIP 文件。");
        const name = basename(zipPath)
          .replace(/\p{Cc}/gu, "_")
          .slice(-255);
        const text = zipMessage.attach(message.text, { name, path: zipPath });
        return submitMessage({ ...message, text }, conversation, state);
      }
      if (stepPath) {
        const scene = options.scene;
        if (!scene || store.getProject(conversation.projectId)?.mode !== "scene")
          throw new Error("只有场景对话可以附加 STEP 文件。");
        const active = state.run;
        if (active?.stopped) throw cancelledSend();
        if (active && !input.delivery) throw new Error("此会话正在运行，请选择插话或完成后发送。");
        const controller = new AbortController();
        const done = Promise.withResolvers<void>();
        const preparing = { controller, done: done.promise };
        state.preparing = preparing;
        let attachmentId: string | undefined;
        try {
          emit(id);
          publish({ type: "workspace" });
          const attachment = await scene.saveStepAttachment(
            conversation.projectId,
            stepPath,
            controller.signal,
          );
          attachmentId = attachment.id;
          controller.signal.throwIfAborted();
          delete state.preparing;
          return await submitMessage(
            {
              ...message,
              text: stepMessage.attach(message.text, attachment),
              stepAttachmentId: attachment.id,
            },
            conversation,
            state,
          );
        } catch (error) {
          if (attachmentId) await discardStepAttachment(conversation.projectId, attachmentId);
          throw error;
        } finally {
          done.resolve();
          if (state.preparing === preparing) {
            delete state.preparing;
            emit(id);
            publish({ type: "workspace" });
          }
        }
      }
      return submitMessage(message, conversation, state);
    },

    async stop(id: string) {
      requireConversation(id);
      const state = sessions.get(id);
      const preparing = state?.preparing;
      preparing?.controller.abort(cancelledSend());
      await requestStop(id, state?.run, state?.session);
      await preparing?.done;
      return null;
    },

    async cancelQueued(id: string, messageId: string) {
      const { projectId } = requireConversation(id);
      const state = runtime(id);
      if (state.delivery?.id === messageId) throw new Error("这条消息正在投递，无法取消。");
      const attachment = queued(id, state).find((item) => item.id === messageId)?.stepAttachmentId;
      removeQueued(id, messageId);
      emit(id);
      if (attachment) await discardStepAttachment(projectId, attachment);
      return null;
    },

    promoteQueued(id: string, messageId: string) {
      requireConversation(id);
      const state = sessions.get(id);
      if (!state?.run || state.run.stopped) throw new Error("当前会话未运行，请点击继续发送。");
      if (state.delivery?.id === messageId) throw new Error("这条消息正在投递，无法改为插话。");
      const item = queued(id, state).find((message) => message.id === messageId);
      if (!item) throw new Error("这条消息已投递或取消。");
      if (!state.eligible?.has(messageId)) throw new Error("这条消息已暂停，请稍后继续发送。");
      store.promoteQueuedMessage(id, messageId);
      item.delivery = "steer";
      emit(id);
      return null;
    },

    async resumeQueue(id: string) {
      const conversation = requireConversation(id);
      const state = runtime(id);
      if (isBusy(state)) throw new Error("请先等待当前运行结束。");
      state.eligible = new Set(queued(id, state).map((item) => item.id));
      const first = nextQueued(id, state);
      if (!first) {
        delete state.eligible;
        return null;
      }
      try {
        await submitMessage(
          {
            id,
            requestId: first.id,
            text: first.text,
            ...(first.images ? { images: first.images } : {}),
            queuedId: first.id,
          },
          conversation,
          state,
        );
      } catch (error) {
        delete state.eligible;
        throw error;
      }
      return null;
    },

    async remove(id: string) {
      const { projectId } = requireConversation(id);
      if (isBusy(sessions.get(id))) throw new Error("请先停止当前会话再删除。");
      await release(id);
      const pending = store.queuedMessages(id);
      history.forget(id);
      store.deleteConversation(id);
      sessions.delete(id);
      publish({ type: "conversationDeleted", id });
      publish({ type: "workspace" });
      for (const { stepAttachmentId } of pending) {
        if (stepAttachmentId) await discardStepAttachment(projectId, stepAttachmentId);
      }
      return null;
    },

    async invalidate(projectId?: string, moduleId?: PluginModule, processServer?: string) {
      const matches = (id: string) => {
        const owner = store.getConversation(id)?.projectId;
        return (
          (!projectId || owner === projectId) &&
          (!moduleId || store.getProject(owner ?? "")?.mode === moduleId) &&
          (!processServer ||
            (owner !== undefined && store.getPlanningProcess(owner) === processServer))
        );
      };
      const affected = [...sessions].filter(
        ([id, state]) => (isBusy(state) || state.session) && matches(id),
      );
      if (affected.some(([, state]) => isBusy(state))) throw new Error("请先停止相关会话。");
      projectHistory.clear();
      for (const [id] of affected) await release(id);
    },

    async close() {
      const results = await Promise.allSettled([...sessions.keys()].map(release));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "部分会话未能正常关闭。");
    },
  };
}
