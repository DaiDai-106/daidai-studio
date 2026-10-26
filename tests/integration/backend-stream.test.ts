import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openRuntime } from "../../src/backend/runtime.ts";
import type { ApplicationEvent } from "../../src/shared/application.ts";

test("native streaming cancellation releases the run; failed provider responses do not enter history", {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-stop-"));
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Drain the SDK request. */
    }
    requests++;
    if (requests === 3) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Invalid schema for function 'test': private-response-test-marker",
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (content: string, finish: string | null) =>
      `data: ${JSON.stringify({ id: "stop-test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finish }] })}\n\n`;
    response.write(
      chunk(requests === 1 ? "Waiting for cancellation" : "Next request completed", null),
    );
    if (requests === 2) response.end(`${chunk("", "stop")}data: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const events: ApplicationEvent[] = [];
  let closed = false;
  const runtime = await openRuntime(
    root,
    {
      available: false,
      read: async () => "{}",
      write: async () => {
        throw new Error("Unexpected credential write");
      },
    },
    (event) => events.push(event),
  );
  const idle = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (!(await runtime.request("workspace.get", {})).busyConversationId) return;
      await setTimeout(10);
    }
    assert.fail("Run never became idle");
  };
  try {
    await runtime.request("provider.save", {
      config: {
        id: "stream-test",
        name: "Stream test",
        providerType: "local",
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        enabled: true,
        authMethod: "none",
        persistCredentials: false,
        models: [{ id: "test", name: "test", context: 8192, output: 1024, reasoning: "标准" }],
      },
    });
    const project = await runtime.request("project.open", { path: root });
    const conversation = await runtime.request("conversation.create", { projectId: project.id });
    await runtime.request("conversation.watch", { id: conversation.id });
    await runtime.request("conversation.send", {
      id: conversation.id,
      requestId: "one",
      text: "Wait",
    });
    for (
      let attempt = 0;
      attempt < 200 && !events.some((event) => event.type === "conversation" && event.view.partial);
      attempt++
    )
      await setTimeout(10);
    assert.ok(events.some((event) => event.type === "conversation" && event.view.partial));
    await assert.rejects(runtime.request("provider.remove", { id: "stream-test" }), /先停止/);
    await assert.rejects(runtime.request("project.remove", { id: project.id }), /先停止/);
    await assert.rejects(runtime.request("conversation.delete", { id: conversation.id }), /先停止/);
    assert.equal((await runtime.request("workspace.get", {})).projects.length, 1);
    await runtime.request("conversation.stop", { id: conversation.id });
    await runtime.request("conversation.stop", { id: conversation.id });
    await runtime.request("conversation.send", {
      id: conversation.id,
      requestId: "two",
      text: "Continue",
    });
    await idle();
    assert.equal(
      (await runtime.request("conversation.watch", { id: conversation.id })).messages.at(-1)?.text,
      "Next request completed",
    );
    await runtime.request("conversation.send", {
      id: conversation.id,
      requestId: "three",
      text: "Fail safely",
    });
    await idle();
    const view = await runtime.request("conversation.watch", { id: conversation.id });
    assert.ok(view.messages.at(-1)?.failed);
    assert.match(view.messages.at(-1)?.text ?? "", /工具参数定义不兼容/);
    assert.ok(
      events.some(
        (event) => event.type === "conversation" && /工具参数定义不兼容/.test(event.view.error),
      ),
    );
    assert.equal(JSON.stringify(view).includes("private-response-test-marker"), false);
    await runtime.close();
    closed = true;
    assert.equal(
      (await readFile(join(root, "app.sqlite"))).includes(
        Buffer.from("private-response-test-marker"),
      ),
      false,
    );
  } finally {
    if (!closed) await runtime.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
