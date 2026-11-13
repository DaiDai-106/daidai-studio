import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createConversations } from "../../../src/backend/agent/conversations.ts";
import { createPackageHandlers } from "../../../src/backend/extensions/package_handlers.ts";
import { createSkillHandlers } from "../../../src/backend/extensions/skill_handlers.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";
import { createSceneService } from "../../../src/backend/scene/scene_service.ts";
import { createSettingsService } from "../../../src/backend/settings/service.ts";

test("并发发送先占位；执行中拒绝变更包和技能，避免半成功", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-concurrency-"));
  const dataRoot = join(root, "data");
  const store = openProjectStore(dataRoot);
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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
  const scenes = createSceneService({ dataRoot, store });
  const conversations = createConversations({
    dataRoot,
    store,
    settings,
    scenes,
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
    const project = store.createProject({ name: "场景", mode: "scene", path: root });
    const conversation = await conversations.create(project.id);
    const first = conversations.send({ id: conversation.id, requestId: "a", text: "第一条" });
    // UI 可能在 Pi agent 异步初始化期间请求当前视图，不能创建第二个空会话文件。
    conversations.watch(conversation.id);
    const initialSessionFile = store.getConversation(conversation.id)?.sessionFile;
    assert.ok(initialSessionFile);
    await conversations.update({ id: conversation.id, title: "初始化期间手动命名" });
    await assert.rejects(
      conversations.send({ id: conversation.id, requestId: "b", text: "第二条" }),
      /正在运行/,
    );
    await first;
    assert.equal(store.getConversation(conversation.id)?.title, "初始化期间手动命名");
    assert.equal(store.getConversation(conversation.id)?.sessionFile, initialSessionFile);
    const packages = createPackageHandlers({ dataRoot, store, changed: conversations.invalidate });
    await assert.rejects(
      packages["package.install"]({ source: root, scope: "project", projectId: project.id }),
      /先停止/,
    );
    await assert.rejects(packages["package.update"]({ projectId: project.id }), /先停止/);
    assert.deepEqual(await packages["package.list"]({ projectId: project.id }), []);
    const skills = createSkillHandlers({ dataRoot, store, changed: conversations.invalidate });
    await assert.rejects(
      skills["skill.library.create"]({
        name: "demo",
        text: "---\nname: demo\ndescription: demo\n---\nDemo",
      }),
      /先停止/,
    );
    assert.deepEqual(await skills["skill.library.list"]({ projectId: project.id }), []);
    const pendingConversation = await conversations.create(project.id);
    const pending = conversations.send({
      id: pendingConversation.id,
      requestId: "pending",
      text: "立刻停止",
    });
    await conversations.stop(pendingConversation.id);
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(conversations.watch(pendingConversation.id).busy, false);
    assert.deepEqual(conversations.watch(pendingConversation.id).messages, []);
  } finally {
    release();
    await conversations.close();
    await scenes.dispose();
    await settings.close();
    store.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
