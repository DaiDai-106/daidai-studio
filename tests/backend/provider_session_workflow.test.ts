import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";
import type { ApplicationEvent, ProviderConfig } from "../../src/contracts/application.ts";

test("忙时拒绝修改模型服务但允许主题，空闲后新会话使用更新端点", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-provider-session-"));
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    if (urls.length === 1) {
      started();
      await gate;
    }
    return new Response(
      'data: {"id":"r","object":"chat.completion.chunk","created":1,"model":"example","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  let handler: (event: ApplicationEvent) => void = () => {};
  const app = await openApplication({
    dataRoot: join(root, "data"),

    publish: (event) => handler(event),
  });
  try {
    const config: ProviderConfig = {
      id: "local",
      name: "Local",
      providerType: "local",
      authMethod: "none",
      endpoint: "http://127.0.0.1:11434/v1",
      enabled: true,

      models: [{ id: "example", name: "Example", context: 4096, output: 1024, reasoning: "标准" }],
    };
    await app.request("provider.save", { config });
    const project = await app.request("project.create", {
      name: "项目",
      mode: "coding",
      path: root,
    });
    const conversation = await app.request("conversation.create", { projectId: project.id });
    let done!: () => void;
    let finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    handler = (event) => {
      if (event.type === "conversation" && !event.view.busy) done();
    };
    await app.request("conversation.send", {
      id: conversation.id,
      requestId: "first",
      text: "你好",
    });
    await firstStarted;
    const changed = { ...config, endpoint: "http://127.0.0.1:11435/v1" };
    await assert.rejects(app.request("provider.save", { config: changed }), /先停止/);
    assert.equal(
      (await app.request("workspace.get", {})).settings.providers[0]?.endpoint,
      config.endpoint,
    );
    assert.equal((await app.request("settings.update", { theme: "dark" })).theme, "dark");
    release();
    await finished;
    await app.request("provider.save", { config: changed });
    finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    await app.request("conversation.send", {
      id: conversation.id,
      requestId: "second",
      text: "继续",
    });
    await finished;
    assert.ok(urls[0]?.includes(":11434/"));
    assert.ok(urls[1]?.includes(":11435/"));
  } finally {
    release();
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
