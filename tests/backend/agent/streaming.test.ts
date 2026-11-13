import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openApplication } from "../../../src/backend/application.ts";
import { type ApplicationEvent, validEvent } from "../../../src/contracts/application.ts";

test("200 个连续片段合并为无历史的进度帧；终态完整且不会被迟到定时器覆盖", {
  timeout: 15000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-stream-batch-"));
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let progress!: () => void;
  const observed = new Promise<void>((done) => {
    progress = done;
  });
  let finish!: () => void;
  const completed = new Promise<void>((done) => {
    finish = done;
  });
  const events: ApplicationEvent[] = [];
  const encode = (delta: object, reason: string | null = null) =>
    `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "example", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          for (let i = 0; i < 200; i++)
            controller.enqueue(new TextEncoder().encode(encode({ content: "x" })));
          await gate;
          controller.enqueue(
            new TextEncoder().encode(
              `${encode({ content: "完成" })}${encode({}, "stop")}data: [DONE]\n\n`,
            ),
          );
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const app = await openApplication({
    dataRoot: join(root, "data"),
    publish(event) {
      events.push(event);
      if (event.type === "conversation.progress" && event.view.partial === "x".repeat(200))
        progress();
      if (event.type === "conversation" && !event.view.busy) finish();
    },
  });
  try {
    await app.request("provider.save", {
      config: {
        id: "local",
        name: "Local",
        providerType: "local",
        authMethod: "none",
        endpoint: "http://127.0.0.1:11434/v1",
        enabled: true,
        models: [
          { id: "example", name: "Example", context: 8192, output: 1024, reasoning: "标准" },
        ],
      },
    });
    const project = await app.request("project.create", { name: "P", mode: "coding", path: root });
    const chat = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.send", { id: chat.id, requestId: "r", text: "问题" });
    await observed;
    const frames = events.filter(
      (event) => event.type === "conversation" || event.type === "conversation.progress",
    );
    const partials = frames.filter((event) => event.type === "conversation.progress");
    assert.ok(partials.length >= 1 && partials.length <= 3);
    assert.ok(frames.length < 20, `${frames.length} 帧没有有效合并流式输出`);
    for (const frame of partials) {
      assert.equal("messages" in frame.view, false);
      assert.ok(frame.view.historyKey);
      assert.ok(validEvent(frame));
      assert.ok(JSON.stringify(frame).length < 2000);
    }
    release();
    await completed;
    const restored = await app.request("conversation.watch", { id: chat.id });
    assert.equal(restored.busy, false);
    assert.equal(restored.partial, "");
    assert.equal(restored.messages.at(-1)?.text, `${"x".repeat(200)}完成`);
    const count = events.length;
    await delay(100);
    assert.equal(events.length, count, "完成后不能再推送过期的进度帧");
  } finally {
    release();
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

for (const outcome of ["stop", "failure"] as const) {
  test(`流式${outcome === "stop" ? "停止" : "失败"}立即进入终态，取消待推送片段`, {
    timeout: 15000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dai-stream-terminal-"));
    const originalFetch = globalThis.fetch;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let observed!: () => void;
    const progress = new Promise<void>((done) => {
      observed = done;
    });
    let finished!: () => void;
    const completed = new Promise<void>((done) => {
      finished = done;
    });
    const events: ApplicationEvent[] = [];
    globalThis.fetch = async (_input, init) =>
      new Response(
        new ReadableStream({
          start(value) {
            controller = value;
            value.enqueue(
              new TextEncoder().encode(
                'data: {"id":"r","object":"chat.completion.chunk","created":1,"model":"example","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
              ),
            );
            init?.signal?.addEventListener(
              "abort",
              () => {
                try {
                  controller.error(new Error("aborted"));
                } catch {}
              },
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const app = await openApplication({
      dataRoot: join(root, "data"),
      publish(event) {
        events.push(event);
        if (event.type === "conversation.progress") observed();
        if (event.type === "conversation" && !event.view.busy) finished();
      },
    });
    try {
      await app.request("provider.save", {
        config: {
          id: "local",
          name: "Local",
          providerType: "local",
          authMethod: "none",
          endpoint: "http://127.0.0.1:11434/v1",
          enabled: true,
          models: [
            { id: "example", name: "Example", context: 8192, output: 1024, reasoning: "标准" },
          ],
        },
      });
      const project = await app.request("project.create", {
        name: "P",
        mode: "coding",
        path: root,
      });
      const chat = await app.request("conversation.create", { projectId: project.id });
      await app.request("conversation.send", { id: chat.id, requestId: "r", text: "问题" });
      await progress;
      if (outcome === "stop") await app.request("conversation.stop", { id: chat.id });
      else controller.error(new Error("401 Unauthorized: test credential rejected"));
      await completed;
      const final = await app.request("conversation.watch", { id: chat.id });
      assert.equal(final.busy, false);
      assert.equal(final.partial, "");
      assert.ok(
        final.error ||
          final.messages.some((message) => message.failed || message.outcome === "stopped"),
      );
      const count = events.length;
      await delay(100);
      assert.equal(events.length, count);
    } finally {
      await app.close();
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
}
