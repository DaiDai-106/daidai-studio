import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
  type AgentEventStream,
  defineExtension,
  GenerationTask,
  type Harness,
  hook,
  type Registry,
  type Storage,
  section,
  watchEvents,
} from "@earendil-works/pi-durable";
import type { ApplicationEvent } from "../../shared/application.ts";
import type { Artifacts } from "../artifacts/store.ts";
import type { Builtins } from "../builtin.ts";
import { ConversationDoc } from "../projects/documents.ts";
import { conversationId, type Projects } from "../projects/handlers.ts";
import { fileHash, resolveStepPath } from "../projects/source.ts";
import type { Settings } from "../settings/handlers.ts";
import type { Handlers } from "../types.ts";
import { createBuiltinAgent } from "./builtin.ts";
import { modelRequestError } from "./errors.ts";
import { createMcpRun } from "./mcp.ts";
import { createProjection } from "./projection.ts";
import { systemInstructions } from "./prompts.ts";
import { selectSkills } from "./skills.ts";
import type { ActiveRun, RunContext } from "./types.ts";

export function createSessionExtension(skillFor: (id: string) => string | undefined) {
  return defineExtension({
    name: "dai",
    sections: [section("custom-skills", ({ conversationId }) => skillFor(String(conversationId)))],
    hooks: [
      hook(GenerationTask, {
        afterResponse(message) {
          // Provider diagnostics can include request bodies. Keep them out of durable history.
          if (message.stopReason === "error") {
            const overflow = isContextOverflow(message);
            const retryable = isRetryableAssistantError(message);
            message.errorMessage = overflow
              ? "maximum context length exceeded"
              : retryable
                ? "503 temporarily unavailable"
                : modelRequestError(message.errorMessage);
            message.content = [];
          }
        },
      }),
    ],
  });
}

export function createSession({
  harness,
  storage,
  registry,
  extension,
  builtins,
  artifacts,
  projects,
  settings,
  idle,
  publish,
}: {
  harness: Harness;
  storage: Storage;
  registry: Registry;
  extension: ReturnType<typeof createSessionExtension>;
  builtins: Builtins;
  artifacts: Artifacts;
  projects: Projects;
  settings: Settings;
  idle(): void;
  publish(event: ApplicationEvent): void;
}) {
  const providers = settings.providers;
  const changed = () => publish({ type: "workspace" });
  let activeRun: ActiveRun | null = null;
  let watch: AgentEventStream | undefined;
  let watchedId: string | null = null;
  let epoch = 0;
  const builtinAgent = createBuiltinAgent(
    builtins,
    () => {
      if (!activeRun?.context) throw new Error("此工具没有有效的场景运行目标。");
      return activeRun.context;
    },
    artifacts,
  );
  registry.install(builtinAgent.extension);
  async function watchConversation(id: string) {
    if (activeRun && activeRun.conversationId !== id)
      throw new Error("请先停止当前请求，再切换对话。");
    const conversation = await projects.conversation(id);
    const generation = ++epoch;
    await watch?.stop();
    const projection = createProjection(id, providers.models);
    watch = await watchEvents(harness, conversation.id, context);
    watchedId = id;
    const initial = projection.apply([watch.snapshot]);
    watch.start(async (events) => {
      if (generation === epoch) publish({ type: "conversation", view: projection.apply(events) });
    });
    return initial;
  }
  async function finishRun(run: ActiveRun, reason: "finished" | "failed" | "stopped") {
    if (reason === "stopped") {
      if (activeRun !== run) return;
      // Retain ownership on cleanup failure so the user can retry stopping.
      await run.mcp?.close();
      await builtins.cad.release();
      if (activeRun === run) activeRun = null;
      return;
    }
    try {
      if (reason === "finished") await artifacts.flush();
      // A stopped run's delayed completion must not release the next run's CAD worker.
      if (activeRun !== run) return;
      await Promise.all([
        run.mcp?.close(),
        reason === "failed" || run.scene ? builtins.cad.release() : undefined,
      ]);
    } finally {
      if (activeRun === run) {
        activeRun = null;
        if (reason === "finished") changed();
      }
    }
  }
  const handlers: Handlers<"conversation.watch" | "conversation.send" | "conversation.stop"> = {
    async "conversation.watch"({ id }) {
      return watchConversation(id);
    },
    async "conversation.send"({ id, requestId, text }) {
      const meta = await projects.metadata(id);
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            text,
            modelId: meta.modelId,
            mode: meta.mode,
            ...(meta.source ? { sourceId: meta.source.id } : {}),
          }),
        )
        .digest("hex");
      const existing = await storage.submissionByRequest(conversationId(id), requestId, context);
      if (existing) {
        if (existing.type === "input" && existing.entry !== undefined) {
          const entry = await storage.entry(existing.entry, context);
          if (
            entry?.entry.data &&
            typeof entry.entry.data === "object" &&
            !Array.isArray(entry.entry.data) &&
            entry.entry.data.fingerprint !== fingerprint
          )
            throw new Error("发送标识与原请求内容不一致。");
        }
        return { submissionId: String(existing.id) };
      }
      idle();
      if (meta.archived) throw new Error("请先恢复此对话。");
      const project = await projects.visible(meta.projectId);
      const config = settings
        .read()
        .providers.find(
          (provider) =>
            provider.enabled &&
            provider.models.some((model) => `${provider.id}:${model.id}` === meta.modelId),
        );
      if (!config) throw new Error("请为此对话选择有效模型。");
      const model = config.models.find((model) => `${config.id}:${model.id}` === meta.modelId);
      if (!model || !(await providers.models.checkAuth(config.id)))
        throw new Error("模型服务尚未认证，请在 AI 设置中重新配置。");
      const conversation = await projects.conversation(id);
      const run: ActiveRun = {
        conversationId: id,
        scene: meta.mode === "scene",
        context: null,
        skillBody: null,
        mcp: null,
      };
      activeRun = run;
      try {
        const skills = selectSkills(settings.read().skills ?? [], meta.mode, project.id);
        run.skillBody = skills.body;
        const enabled = meta.mode === "scene";
        const builtinTools = enabled ? builtinAgent.tools(settings.enabled) : [];
        const external = createMcpRun(
          registry,
          settings.read().mcpServers ?? [],
          meta.mode,
          project,
          id,
          builtinTools,
        );
        run.mcp = external;
        const tools = [...builtinTools, ...(external?.tools ?? [])];
        const toolNames = tools.map((tool) => tool.name);
        if (enabled) {
          let source: RunContext["source"] = null;
          if (meta.source) {
            try {
              const file = await resolveStepPath(project.path, meta.source.relativePath);
              const hash = await fileHash(file.path, 512 * 1024 * 1024);
              source = { ...meta.source, path: file.path, sha256: hash.sha256 };
            } catch {
              // Keep discussion available; the import tool reports the missing source.
            }
          }
          run.context = {
            conversationId: id,
            project,
            source,
            skill: settings.enabled("builtin-scene")
              ? (builtins.skills.get("scene-building") ?? null)
              : null,
          };
        } else run.context = null;
        await conversation.configure(
          {
            model: { provider: config.id, modelId: model.id },
            extensions: [
              extension,
              ...(enabled ? [builtinAgent.extension] : []),
              ...(external ? [external.extension] : []),
            ],
            tools,
            modelTools: tools,
            instructions: systemInstructions(meta.mode, toolNames, !!external),
          },
          context,
        );
        if (watchedId !== id) await watchConversation(id);
        const submission = await conversation.submit(
          {
            type: "input",
            requestId,
            whenBusy: "reject",
            content: text,
            entry: {
              kind: "app.input",
              data: {
                fingerprint,
                model: { provider: config.id, modelId: model.id },
                mode: meta.mode,
                skills: skills.metadata,
                mcpServers: external?.metadata ?? [],
                sourceId: run.context?.source?.id ?? null,
                sourceHash: run.context?.source?.sha256 ?? null,
                tools: toolNames,
                skillHash: run.context?.skill
                  ? createHash("sha256").update(run.context.skill).digest("hex")
                  : null,
              },
            },
          },
          context,
        );
        await harness.commit(async (tx) => {
          const document = await tx.doc(ConversationDoc, conversation.id);
          if (document.title === "新建对话") document.title = text.slice(0, 40);
          document.draft = "";
          document.interrupted = false;
        }, context);
        changed();
        void submission
          .wait(context)
          .finally(() => finishRun(run, "finished"))
          .catch(() => {
            console.error("Conversation ended unexpectedly; provider details omitted.");
          });
        return { submissionId: String(submission.id) };
      } catch (error) {
        try {
          await finishRun(run, "failed");
        } finally {
          changed();
        }
        throw error;
      }
    },
    async "conversation.stop"({ id }) {
      const conversation = await projects.conversation(id);
      await conversation.abort(context, { background: true });
      const run = activeRun;
      if (run?.conversationId === id) await finishRun(run, "stopped");
      changed();
      return null;
    },
  };
  async function unwatch() {
    ++epoch;
    await watch?.stop();
    watch = undefined;
    watchedId = null;
  }
  return {
    handlers,
    unwatch,
    busyId: () => activeRun?.conversationId ?? null,
    watchedId: () => watchedId,
    skillFor: (id: string) =>
      activeRun?.conversationId === id ? (activeRun.skillBody ?? undefined) : undefined,
    closeExternal: () => activeRun?.mcp?.close(),
  };
}
export type AgentSession = ReturnType<typeof createSession>;
