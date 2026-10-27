import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openRuntime } from "../../src/backend/runtime.ts";
import type { ApplicationEvent } from "../../src/shared/application.ts";

test("stream events are coalesced without losing the final message or delivering an old watcher", {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dai-batch-"));
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
      /* drain request */
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (let i = 0; i < 120; i++) {
      response.write(
        `data: ${JSON.stringify({ id: "stream", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] })}\n\n`,
      );
      await setTimeout(2);
    }
    response.end(
      `data: ${JSON.stringify({ id: "stream", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const events: ApplicationEvent[] = [];
  const app = await openRuntime(
    root,
    { available: false, read: async () => "{}", write: async () => {} },
    (event) => events.push(event),
  );
  try {
    await app.request("provider.save", {
      config: {
        id: "local",
        name: "Test",
        providerType: "local",
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        enabled: true,
        authMethod: "none",
        persistCredentials: false,
        models: [{ id: "test", name: "Test", context: 8192, output: 1024, reasoning: "标准" }],
      },
    });
    const project = await app.request("project.open", { path: root });
    const id = (await app.request("conversation.create", { projectId: project.id })).id;
    await app.request("conversation.watch", { id });
    await app.request("conversation.send", { id, requestId: "burst", text: "Stream" });
    for (
      let i = 0;
      i < 500 && !events.some((event) => event.type === "conversation" && event.view.partial);
      i++
    )
      await setTimeout(10);
    assert.ok(events.some((event) => event.type === "conversation" && event.view.partial));
    const replacement = await app.request("conversation.watch", { id });
    const previousCount = events.length;
    for (
      let i = 0;
      i < 500 &&
      !events.some(
        (event) =>
          event.type === "conversation" &&
          event.view.streamId === replacement.streamId &&
          !event.view.busy &&
          event.view.messages.some(
            (message) => message.role === "assistant" && message.text === "x".repeat(120),
          ),
      );
      i++
    )
      await setTimeout(10);
    const updates = events.slice(previousCount).filter((event) => event.type === "conversation");
    t.diagnostic(`120 streamed chunks; ${updates.length} conversation updates after rewatch`);
    assert.ok(updates.length > 0);
    assert.ok(updates.every((event) => event.view.streamId === replacement.streamId));
    assert.ok(
      updates.some(
        (event) =>
          !event.view.busy &&
          event.view.messages.some(
            (message) => message.role === "assistant" && message.text === "x".repeat(120),
          ),
      ),
    );
    assert.ok(updates.length < 60, `Expected coalesced events, received ${updates.length}`);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
