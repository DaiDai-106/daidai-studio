import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openRuntime } from "../../src/backend/runtime.ts";
import type { ApplicationEvent, ProviderConfig } from "../../src/shared/application.ts";

test("one durable database persists settings, authenticated chat and archives without storing secrets", {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-runtime-"));
  const requests: { authorization: string | undefined; body: string }[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "local-test" }] }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ authorization: request.headers.authorization, body });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [content, finish] of [
      ["真实协议", null],
      ["测试回复", null],
      ["", "stop"],
    ] as const)
      response.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "local-test", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finish }] })}\n\n`,
      );
    response.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "local-test", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 800 } } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let encrypted = "{}";
  const vault = {
    available: true,
    read: async () => encrypted,
    write: async (value: string) => {
      encrypted = value;
    },
  };
  const events: ApplicationEvent[] = [];
  let runtime = await openRuntime(root, vault, (event) => events.push(event));
  try {
    const types = await runtime.request("provider.types", {});
    assert.ok(types.some((type) => type.id === "deepseek"));
    assert.ok(
      types.some(
        (type) =>
          type.id === "openai-codex" && type.methods.some((method) => method.id === "oauth"),
      ),
    );
    const login = await runtime.request("auth.start", {
      providerType: "deepseek",
      method: "api_key",
    });
    assert.ok(login.prompt);
    await runtime.request("auth.answer", {
      id: login.id,
      promptId: login.prompt.id,
      value: "secret-for-isolated-test",
    });
    const config: ProviderConfig = {
      id: "test-service",
      providerType: "deepseek",
      name: "本地协议测试",
      authMethod: "api_key",
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      enabled: true,
      persistCredentials: true,
      models: [],
    };
    const models = await runtime.request("provider.models", {
      config,
      loginId: login.id,
      discover: false,
    });
    assert.ok(models[0], "Read the actual built-in DeepSeek catalogue.");
    config.models = [{ ...models[0], output: 1024 }];
    await runtime.request("provider.save", { config, loginId: login.id });
    const project = await runtime.request("project.open", { path: root });
    await writeFile(join(root, "source.step"), "Unmodified source STEP placeholder");
    const conversation = await runtime.request("conversation.create", { projectId: project.id });
    await runtime.request("conversation.watch", { id: conversation.id });
    const first = await runtime.request("conversation.send", {
      id: conversation.id,
      requestId: "test-message",
      text: "你好",
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No completed run")), 10000);
      const poll = setInterval(() => {
        if (
          events.some(
            (event) =>
              event.type === "conversation" &&
              !event.view.busy &&
              event.view.messages.some((message) => message.text === "真实协议测试回复"),
          )
        ) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 10);
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.authorization, "Bearer secret-for-isolated-test");
    assert.ok(requests[0]?.body.includes("你好"));
    const request = JSON.parse(requests[0]?.body ?? "{}") as {
      messages: { role: string; content: string }[];
      tools?: { function: { name: string } }[];
    };
    const instructions = request.messages
      .filter((message) => message.role === "system" || message.role === "developer")
      .map((message) => message.content)
      .join("\n");
    assert.match(instructions, /你是呆呆（Dai）/);
    assert.match(instructions, /当前模式：通用对话/);
    assert.match(instructions, /没有提供可调用的工具/);
    assert.doesNotMatch(instructions, /当前模式：场景搭建/);
    assert.deepEqual(request.tools ?? [], []);
    await runtime.request("conversation.update", { id: conversation.id, mode: "scene" });
    await runtime.request("conversation.send", {
      id: conversation.id,
      requestId: "unavailable-scene",
      text: "讨论场景方案",
    });
    while ((await runtime.request("workspace.get", {})).busyConversationId)
      await new Promise((done) => setTimeout(done, 10));
    assert.equal(requests.length, 2);
    const sceneRequest = JSON.parse(requests[1]?.body ?? "{}") as typeof request;
    assert.deepEqual(
      (sceneRequest.tools ?? []).map((tool) => tool.function.name),
      ["read", process.platform === "win32" ? "powershell" : "bash"],
      "Pi read and the approved shell are available without native scene tools.",
    );
    assert.match(
      sceneRequest.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n"),
      /当前模式：场景搭建/,
    );
    await runtime.request("conversation.update", { id: conversation.id, mode: "general" });
    const measured = await runtime.request("conversation.watch", { id: conversation.id });
    assert.equal(measured.usage.input, 400);
    assert.equal(measured.usage.cacheRead, 1600);
    assert.equal(measured.usage.output, 200);
    assert.equal(measured.usage.totalTokens, 2200);
    assert.ok(measured.usage.estimatedCostUsd !== null && measured.usage.estimatedCostUsd > 0);
    assert.equal(measured.latestResponse?.model, "local-test");
    assert.ok(measured.latestResponse?.contextWindow);
    const duplicate = await runtime.request("conversation.send", {
      id: conversation.id,
      requestId: "test-message",
      text: "你好",
    });
    assert.equal(first.submissionId, duplicate.submissionId);
    await assert.rejects(
      runtime.request("conversation.send", {
        id: conversation.id,
        requestId: "test-message",
        text: "不同输入",
      }),
      /不一致/,
    );
    await runtime.request("conversation.update", { id: conversation.id, archived: true });
    await runtime.request("conversation.update", { id: conversation.id, draft: "保留的草稿" });
    await runtime.request("project.remove", { id: project.id });
    await runtime.request("project.remove", { id: project.id });
    assert.deepEqual((await runtime.request("workspace.get", {})).projects, []);
    assert.deepEqual((await runtime.request("workspace.get", {})).conversations, []);
    assert.equal(
      await readFile(join(root, "source.step"), "utf8"),
      "Unmodified source STEP placeholder",
    );
    await runtime.close();
    runtime = await openRuntime(root, vault, () => {});
    assert.deepEqual((await runtime.request("workspace.get", {})).projects, []);
    await assert.rejects(
      runtime.request("conversation.watch", { id: conversation.id }),
      /项目已移除/,
    );
    await assert.rejects(
      runtime.request("conversation.create", { projectId: project.id }),
      /项目已移除/,
    );
    const restored = await runtime.request("project.open", { path: root });
    assert.equal(restored.id, project.id);
    assert.equal(Object.hasOwn(restored, "hidden"), false);
    const reopened = await runtime.request("workspace.get", {});
    assert.equal(reopened.settings.providers[0]?.configured, true);
    assert.equal(reopened.conversations[0]?.archived, true);
    assert.equal(reopened.conversations[0]?.id, conversation.id);
    assert.equal(reopened.conversations[0]?.draft, "保留的草稿");
    const history = await runtime.request("conversation.watch", { id: conversation.id });
    assert.equal(history.messages.at(-1)?.text, "真实协议测试回复");
    assert.deepEqual(history.usage, measured.usage);
    assert.deepEqual(history.latestResponse, measured.latestResponse);
    assert.equal(requests.length, 2, "Reopening storage must not call a model.");
    assert.equal(
      (await readFile(join(root, "app.sqlite"))).includes(Buffer.from("secret-for-isolated-test")),
      false,
    );
    assert.equal(JSON.stringify(reopened).includes("secret-for-isolated-test"), false);
    const survivor = await runtime.request("conversation.create", { projectId: project.id });
    await runtime.request("conversation.delete", { id: conversation.id });
    await runtime.request("conversation.delete", { id: conversation.id });
    assert.deepEqual(
      (await runtime.request("workspace.get", {})).conversations.map((item) => item.id),
      [survivor.id],
    );
    await assert.rejects(runtime.request("conversation.watch", { id: conversation.id }), /已删除/);
    await assert.rejects(
      runtime.request("conversation.update", { id: conversation.id, archived: false }),
      /已删除/,
    );
    await assert.rejects(runtime.request("conversation.stop", { id: conversation.id }), /已删除/);
    await assert.rejects(
      runtime.request("conversation.send", {
        id: conversation.id,
        requestId: "test-message",
        text: "你好",
      }),
      /已删除/,
    );
    await runtime.close();
    runtime = await openRuntime(root, vault, () => {});
    assert.deepEqual(
      (await runtime.request("workspace.get", {})).conversations.map((item) => item.id),
      [survivor.id],
    );
    await runtime.request("project.remove", { id: project.id });
    await runtime.request("project.open", { path: root });
    await assert.rejects(runtime.request("conversation.watch", { id: conversation.id }), /已删除/);
    assert.equal(
      await readFile(join(root, "source.step"), "utf8"),
      "Unmodified source STEP placeholder",
    );
    assert.equal(requests.length, 2);
  } finally {
    await runtime.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("hidden projects do not consume history pages, and reopening a normalized path keeps its identity", {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-project-pages-"));
  const runtime = await openRuntime(
    root,
    {
      available: false,
      read: async () => "{}",
      write: async () => {
        throw new Error("Unexpected credential write");
      },
    },
    () => {},
  );
  try {
    await mkdir(join(root, "first"));
    await mkdir(join(root, "second"));
    const first = await runtime.request("project.open", { path: join(root, "first") });
    const older = await runtime.request("conversation.create", { projectId: first.id });
    const second = await runtime.request("project.open", { path: join(root, "second") });
    for (let index = 0; index < 101; index++)
      await runtime.request("conversation.create", { projectId: second.id });
    const page = await runtime.request("workspace.get", {});
    assert.equal(page.conversations.length, 100);
    assert.ok(page.nextCursor);
    for (const item of page.conversations)
      await runtime.request("conversation.delete", { id: item.id });
    const afterDeletion = await runtime.request("workspace.get", {});
    assert.equal(
      afterDeletion.conversations.length,
      2,
      "Deleted records must not consume history pages.",
    );
    assert.equal(afterDeletion.nextCursor, null);
    await runtime.request("project.remove", { id: second.id });
    const remaining = await runtime.request("workspace.get", {});
    assert.deepEqual(
      remaining.projects.map((project) => project.id),
      [first.id],
    );
    assert.deepEqual(
      remaining.conversations.map((conversation) => conversation.id),
      [older.id],
    );
    assert.equal(remaining.nextCursor, null);
    await runtime.request("project.open", { path: join(root, "second") });
    assert.equal((await runtime.request("workspace.get", {})).conversations.length, 2);
    if (process.platform !== "win32") {
      await runtime.request("project.remove", { id: first.id });
      await symlink(first.path, join(root, "alias"));
      const restored = await runtime.request("project.open", { path: join(root, "alias") });
      assert.equal(restored.id, first.id);
      assert.equal(restored.path, first.path);
    }
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
