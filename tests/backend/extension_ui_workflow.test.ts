import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";
import type { ApplicationEvent, ExtensionUiRequest } from "../../src/contracts/application.ts";
import { runPackageAction } from "../support/catalog_task.ts";

test("真实 Pi package 的确认、选择、输入经桌面桥交互后继续工具", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-extension-ui-"));
  const source = join(root, "package");
  await mkdir(join(source, "extensions"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "dai-ui-test" }));
  await writeFile(
    join(source, "extensions", "index.ts"),
    `export default pi => pi.registerTool({
    name: 'ask_user', label: 'Ask', description: 'Ask the user', parameters: {type:'object',properties:{}},
    execute: async (_id, _params, _signal, _update, ctx) => {
      const confirmed = await ctx.ui.confirm('确认操作', '继续吗？');
      const choice = await ctx.ui.select('选择模式', ['A', 'B']);
      const name = await ctx.ui.input('输入名称', '例如 robot');
      return {content:[{type:'text',text:JSON.stringify({confirmed,choice,name})}],details:{}};
    }
  });`,
  );
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    const delta =
      fetches === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "ask",
                type: "function",
                function: { name: "ask_user", arguments: "{}" },
              },
            ],
          }
        : { role: "assistant", content: "完成" };
    const chunk = (value: object, reason: string | null) =>
      `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "example", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
    return new Response(
      `${chunk(delta, null)}${chunk({}, fetches === 1 ? "tool_calls" : "stop")}data: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  let handler: (event: ApplicationEvent) => void = () => {};
  const app = await openApplication({
    dataRoot: join(root, "data"),

    publish: (event) => handler(event),
  });
  try {
    const project = await app.request("project.create", {
      name: "项目",
      mode: "coding",
      path: root,
    });
    await runPackageAction(app, {
      action: "install",
      moduleId: "coding",
      scope: "module",
      source,
    });
    await app.request("provider.save", {
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
    const conversation = await app.request("conversation.create", { projectId: project.id });
    const requests: ExtensionUiRequest[] = [];
    let resolveRequest!: (value: ExtensionUiRequest) => void;
    let pending = new Promise<ExtensionUiRequest>((resolve) => {
      resolveRequest = resolve;
    });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    handler = (event) => {
      if (event.type === "extension.ui.request") {
        requests.push(event.request);
        resolveRequest(event.request);
      }
      if (event.type === "conversation" && !event.view.busy) resolveDone();
    };
    await app.request("conversation.send", {
      id: conversation.id,
      requestId: "request",
      text: "运行交互",
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("未收到扩展交互请求")), 5_000);
      }),
    ]);
    if (deadline) clearTimeout(deadline);
    assert.equal(first.kind, "confirm");
    assert.equal(
      (await app.request("workspace.get", {})).extensionUiRequests?.[0]?.requestId,
      first.requestId,
    );
    pending = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    await app.request("extension.ui.respond", {
      requestId: first.requestId,
      cancelled: false,
      value: "true",
    });
    const second = await pending;
    assert.equal(second.kind, "select");
    assert.deepEqual(second.options, ["A", "B"]);
    pending = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    await app.request("extension.ui.respond", {
      requestId: second.requestId,
      cancelled: false,
      value: "B",
    });
    const third = await pending;
    assert.equal(third.kind, "input");
    await app.request("extension.ui.respond", {
      requestId: third.requestId,
      cancelled: false,
      value: "robot",
    });
    await done;
    const view = await app.request("conversation.watch", { id: conversation.id });
    assert.ok(
      view.messages.some(
        (message) =>
          message.role === "tool" && message.tool?.name === "ask_user" && !message.failed,
      ),
    );
    assert.equal(requests.length, 3);
    fetches = 0;
    const stoppedConversation = await app.request("conversation.create", { projectId: project.id });
    let resolveStoppedRequest!: (value: ExtensionUiRequest) => void;
    const stoppedRequest = new Promise<ExtensionUiRequest>((resolve) => {
      resolveStoppedRequest = resolve;
    });
    let resolveDismissed!: () => void;
    const dismissed = new Promise<void>((resolve) => {
      resolveDismissed = resolve;
    });
    handler = (event) => {
      if (
        event.type === "extension.ui.request" &&
        event.request.conversationId === stoppedConversation.id
      )
        resolveStoppedRequest(event.request);
      if (
        event.type === "extension.ui.dismissed" &&
        event.conversationId === stoppedConversation.id
      )
        resolveDismissed();
    };
    await app.request("conversation.send", {
      id: stoppedConversation.id,
      requestId: "stop-request",
      text: "运行后停止",
    });
    const waiting = await stoppedRequest;
    await app.request("conversation.stop", { id: stoppedConversation.id });
    await dismissed;
    assert.ok(
      !(await app.request("workspace.get", {})).extensionUiRequests?.some(
        (item) => item.requestId === waiting.requestId,
      ),
    );
    await assert.rejects(
      app.request("extension.ui.respond", {
        requestId: waiting.requestId,
        cancelled: false,
        value: "true",
      }),
      /失效/,
    );
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
