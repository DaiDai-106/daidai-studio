import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Cursor, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  type ApplicationEvent,
  type Arguments,
  type ConversationInfo,
  type Method,
  type Results,
  validateRequest,
} from "../shared/application.ts";
import { type AgentSession, createSession, createSessionExtension } from "./agent/session.ts";
import { createArtifacts } from "./artifacts/store.ts";
import { type BuiltinPaths, loadBuiltins } from "./builtin.ts";
import { createMcpHandlers } from "./mcp/handlers.ts";
import { ConversationDoc } from "./projects/documents.ts";
import { projectFiles } from "./projects/files.ts";
import { createProjects } from "./projects/handlers.ts";
import { createPlacements } from "./projects/placements.ts";
import type { VaultPort } from "./settings/credentials.ts";
import { createSettings } from "./settings/handlers.ts";
import type { Handlers } from "./types.ts";

export async function openRuntime(
  root: string,
  vault: VaultPort,
  publish: (event: ApplicationEvent) => void,
  builtinPaths: BuiltinPaths = {},
) {
  const builtins = await loadBuiltins(builtinPaths, join(root, "tmp"));
  const storage = await openNodeSqliteStorage(join(root, "app.sqlite"));
  let harness: Harness;
  const settings = await createSettings(vault, () => harness, publish);
  let session: AgentSession | undefined;
  const registry = createRegistry();
  const extension = createSessionExtension((id) => session?.skillFor(id));
  registry.install(extension);
  harness = await Harness.open(
    storage,
    {
      models: settings.providers.models,
      registry,
      settings: {
        toolExecution: "sequential",
        retry: { maxRetries: 2 },
        stream: { timeoutMs: 120_000, maxRetries: 0 },
        compaction: { backgroundTokens: 0 },
      },
      onReport: () =>
        console.error(
          "Agent runtime reported a failure; secrets and request details were omitted.",
        ),
    },
    context,
  );
  // Mark ALL old work before any API capable of starting the scheduler is used.
  const inspection = await harness.inspect(context);
  const interrupted = new Set(
    inspection.submissions.map((submission) => submission.conversationId),
  );
  for (const submission of inspection.submissions)
    if (submission.status === "queued") await harness.abortSubmission(submission.id, context);
  for (const task of inspection.tasks) await harness.abortTask(task.record.id, context);
  if (inspection.tasks.length || inspection.submissions.length) await harness.waitForIdle(context);
  for (const id of interrupted)
    if (await harness.snapshot(ConversationDoc, id, context))
      await harness.commit(async (tx) => {
        (await tx.doc(ConversationDoc, id)).interrupted = true;
      }, context);
  const logins = await settings.initialize();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let mutations = Promise.resolve();
  const artifacts = createArtifacts(harness, storage, publish, root);
  await artifacts.recover();
  const placements = createPlacements(harness, storage, publish, root);
  await placements.recover();
  const projects = createProjects(harness, storage, settings.model);
  const mcp = createMcpHandlers(settings, projects, idle);
  session = createSession({
    harness,
    storage,
    registry,
    extension,
    builtins,
    artifacts,
    placements,
    projects,
    settings,
    idle,
    publish,
  });
  function idle() {
    if (session?.busyId() || closing || mcp.inspecting())
      throw new Error(
        closing ? "应用正在退出。" : "请先停止当前请求，再修改配置或项目、切换对话。",
      );
  }
  const handlers: Handlers = {
    ...settings.requests({
      idle,
      logins,
      projects,
      releaseBuiltin: async (id) => {
        await builtins.services.find((service) => service.descriptor.id === id)?.release();
      },
    }),
    ...projects.requests({
      idle,
      defaultModel: () => settings.read().defaultModel,
      watcher: {
        currentId: () => session?.watchedId() ?? null,
        stop: async () => {
          await session?.unwatch();
        },
      },
      display: {
        get: async (sourceId) => {
          const model = await artifacts.get(sourceId);
          return model ? { ...model, placement: await placements.get(model) } : null;
        },
      },
      publish,
    }),
    ...mcp.handlers,
    ...session.handlers,
    async "workspace.get"({ cursor }) {
      const records = (await projects.records()).filter((project) => !project.hidden);
      const visibleIds = new Set(records.map((project) => project.id));
      const conversations: ConversationInfo[] = [];
      let next = cursor ? (JSON.parse(cursor) as Cursor) : undefined;
      if (visibleIds.size) {
        do {
          const page = await storage.scanConversations(
            { order: "descending" },
            100 - conversations.length,
            next,
            context,
          );
          for (const record of page.items) {
            const value = await harness.snapshot(ConversationDoc, record.id, context);
            if (value && !value.deletedAt && visibleIds.has(value.projectId))
              conversations.push(await projects.metadata(String(record.id)));
          }
          next = page.next;
        } while (next && conversations.length < 100);
      } else next = undefined;
      return {
        settings: await settings.info(),
        projects: await Promise.all(records.map(projectFiles)),
        conversations,
        nextCursor: next ? JSON.stringify(next) : null,
        dataRoot: root,
        secureStorage: vault.available,
        busyConversationId: session?.busyId() ?? null,
        shellApproval: session?.shellApproval() ?? null,
        cadAvailable: builtins.cad.available && settings.enabled("builtin.cad"),
        builtins: builtins.catalog,
      };
    },
  };
  return {
    resolveResource: artifacts.resource,
    async request<K extends Method>(method: K, args: Arguments<K>): Promise<Results[K]> {
      validateRequest(method, args);
      // Cancellation must reach discovery instead of waiting behind the request it cancels.
      if (method === "mcp.cancelInspect") return handlers[method](args);
      if (method === "shell.respond") return handlers[method](args);
      const result = mutations.then(() => handlers[method](args));
      mutations = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    close() {
      closing = true;
      mcp.abort();
      closePromise ??= Promise.resolve().then(async () => {
        logins.close();
        await mutations;
        await session?.unwatch();
        const state = await harness.inspect(context);
        for (const submission of state.submissions)
          if (submission.status === "queued") await harness.abortSubmission(submission.id, context);
        for (const task of state.tasks) await harness.abortTask(task.record.id, context);
        await harness.waitForIdle(context);
        const cleanup = await Promise.allSettled([session?.closeExternal(), builtins.close()]);
        await artifacts.close();
        await placements.close();
        await harness.close(context);
        if (cleanup.some((result) => result.status === "rejected"))
          throw new Error("后端资源清理未全部成功。");
      });
      return closePromise;
    },
  };
}
