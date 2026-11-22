import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createConversations } from "../../../src/backend/agent/conversations.ts";
import { createCatalogService } from "../../../src/backend/extensions/catalog_service.ts";
import { createSkillHandlers } from "../../../src/backend/extensions/skill_handlers.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";
import { createSettingsService } from "../../../src/backend/settings/service.ts";
import { waitForCatalogTask } from "../../support/catalog_task.ts";

test("并发发送先占位；执行中拒绝变更包和技能，避免半成功", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-concurrency-"));
  const dataRoot = join(root, "data");
  const store = openProjectStore(dataRoot);
  const originalFetch = globalThis.fetch;
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          await gate;
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"id":"r","object":"chat.completion.chunk","created":1,"model":"example","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const settings = await createSettingsService({
    dataRoot,

    publish: () => {},
  });
  let waitForStartup: (() => Promise<void>) | undefined;
  const conversations = createConversations({
    dataRoot,
    store,
    settings: {
      ...settings,
      async info() {
        await waitForStartup?.();
        return settings.info();
      },
    },
    publish: () => {},
  });
  try {
    await settings.handlers["provider.save"]({
      config: {
        id: "local",
        name: "Local",
        providerType: "local",
        authMethod: "none",
        endpoint: "http://127.0.0.1:11434/v1",
        enabled: true,

        models: [
          { id: "example", name: "Example", context: 4096, output: 1024, reasoning: "标准" },
        ],
      },
    });
    const project = store.createProject({ name: "场景", mode: "coding", path: root });
    const conversation = await conversations.create(project.id);
    const interrupted = store.updateConversation(conversation.id, { interrupted: true });
    assert.equal(conversations.metadata(interrupted).interrupted, true);
    const first = conversations.send({ id: conversation.id, requestId: "a", text: "第一条" });
    // 界面可在 Agent 初始化期间读视图，绑定会话文件只由发送路径写入。
    conversations.watch(conversation.id);
    assert.equal(store.getConversation(conversation.id)?.sessionFile, null);
    await conversations.update({ id: conversation.id, title: "初始化期间手动命名" });
    await assert.rejects(
      conversations.send({ id: conversation.id, requestId: "b", text: "第二条" }),
      /正在运行/,
    );
    await first;
    const running = store.getConversation(conversation.id);
    assert.ok(running);
    assert.equal(running.title, "初始化期间手动命名");
    assert.equal(running.interrupted, true);
    assert.equal(conversations.metadata(running).interrupted, false);
    const initialSessionFile = running.sessionFile;
    assert.ok(initialSessionFile);
    conversations.watch(conversation.id);
    assert.equal(store.getConversation(conversation.id)?.sessionFile, initialSessionFile);
    await assert.rejects(conversations.update({ id: conversation.id, archived: true }), /先停止/);
    await assert.rejects(conversations.remove(conversation.id), /先停止/);
    const catalog = createCatalogService({
      dataRoot,
      changed: (moduleId) => conversations.invalidate(undefined, moduleId),
      publish() {},
    });
    for (const action of ["install", "update"] as const) {
      const task = catalog.start({ action, source: root, scope: "module", moduleId: "coding" });
      const result = await waitForCatalogTask(() => catalog.taskList(), task.id);
      assert.equal(result.state, "failed");
      assert.match(result.message, /先停止/);
    }
    assert.deepEqual(await catalog.installed("coding"), []);
    await catalog.close();
    const skills = createSkillHandlers({ dataRoot, changed: conversations.invalidate });
    await assert.rejects(
      skills["skill.library.create"]({
        name: "demo",
        text: "---\nname: demo\ndescription: demo\n---\nDemo",
      }),
      /先停止/,
    );
    assert.deepEqual(await skills["skill.library.list"]({ moduleId: "coding" }), []);
    const pendingConversation = store.createConversation(project.id);
    await conversations.update({ id: pendingConversation.id, draft: "立刻停止" });
    const { promise: starting, resolve: start } = Promise.withResolvers<void>();
    const { promise: startup, resolve: resumeStartup } = Promise.withResolvers<void>();
    waitForStartup = () => {
      start();
      return startup;
    };
    const pending = conversations.send({
      id: pendingConversation.id,
      requestId: "pending",
      text: "立刻停止",
    });
    const cancelled = assert.rejects(pending, /发送已取消/);
    try {
      await starting;
      assert.deepEqual(
        new Set(conversations.busyIds()),
        new Set([conversation.id, pendingConversation.id]),
      );
      await conversations.stop(pendingConversation.id);
    } finally {
      resumeStartup();
    }
    await cancelled;
    assert.equal(conversations.watch(pendingConversation.id).busy, false);
    assert.deepEqual(conversations.watch(pendingConversation.id).messages, []);
    assert.equal(store.getConversation(pendingConversation.id)?.draft, "立刻停止");
    assert.equal(store.getConversation(pendingConversation.id)?.title, "新会话");
    assert.equal(store.getConversation(pendingConversation.id)?.interrupted, false);
    assert.deepEqual(conversations.busyIds(), [conversation.id]);
  } finally {
    release();
    await conversations.close();
    await settings.close();
    store.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("初始化持久化失败时释放会话占位", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-run-write-failure-"));
  const store = openProjectStore(root);
  const settings = await createSettingsService({ dataRoot: root, publish() {} });
  const conversations = createConversations({
    dataRoot: root,
    settings,
    publish() {},
    store: {
      ...store,
      updateConversation(id, change) {
        if (change.interrupted === true) throw new Error("模拟启动时 SQLite 写入失败");
        return store.updateConversation(id, change);
      },
    },
  });
  try {
    await settings.handlers["provider.save"]({
      config: {
        id: "local",
        name: "Local",
        providerType: "local",
        authMethod: "none",
        endpoint: "http://127.0.0.1:11434/v1",
        enabled: true,
        models: [
          { id: "example", name: "Example", context: 4096, output: 1024, reasoning: "标准" },
        ],
      },
    });
    const project = store.createProject({ name: "P", mode: "coding", path: root });
    const conversation = await conversations.create(project.id);
    await conversations.update({ id: conversation.id, draft: "未送出的草稿" });
    await assert.rejects(
      conversations.send({ id: conversation.id, requestId: "failed", text: "未送出的草稿" }),
      /SQLite 写入失败/,
    );
    assert.deepEqual(conversations.busyIds(), []);
    assert.equal(store.getConversation(conversation.id)?.draft, "未送出的草稿");
    await conversations.remove(conversation.id);
  } finally {
    await conversations.close();
    await settings.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
