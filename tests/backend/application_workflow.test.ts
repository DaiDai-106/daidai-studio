import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";
import type { ApplicationEvent } from "../../src/contracts/application.ts";

test("project chats and a fork persist independently through the new Pi backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-workflow-"));
  const image = {
    mimeType: "image/png" as const,
    data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
  };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let requestBody = "";
  globalThis.fetch = async (_input, init) => {
    calls++;
    requestBody = String(init?.body);
    const chunks = [
      {
        id: "result",
        object: "chat.completion.chunk",
        created: 1,
        model: "example",
        choices: [
          { index: 0, delta: { role: "assistant", content: "搭建建议" }, finish_reason: null },
        ],
      },
      {
        id: "result",
        object: "chat.completion.chunk",
        created: 1,
        model: "example",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ];
    return new Response(
      `${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  let onEvent: (event: ApplicationEvent) => void = () => {};
  let app: Awaited<ReturnType<typeof openApplication>> | undefined;
  try {
    app = await openApplication({
      dataRoot: join(root, "data"),

      publish: (event) => onEvent(event),
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
          {
            id: "example",
            name: "Example",
            context: 4096,
            output: 1024,
            reasoning: "标准",
            supportsImages: true,
          },
        ],
      },
    });
    const project = await app.request("project.create", {
      name: "场景",
      path: root,
      mode: "coding",
    });
    const first = await app.request("conversation.create", { projectId: project.id });
    const independent = await app.request("conversation.create", { projectId: project.id });
    const finished = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("会话未结束")), 10_000);
      onEvent = (event) => {
        if (
          event.type === "conversation" &&
          event.view.conversationId === first.id &&
          !event.view.busy
        ) {
          clearTimeout(timeout);
          resolve();
        }
      };
    });
    await app.request("conversation.send", {
      id: first.id,
      requestId: "request-1",
      text: "帮我搭建场景",
      images: [image],
    });
    await finished;
    const result = await app.request("conversation.watch", { id: first.id });
    assert.equal(result.error, "");
    assert.ok(requestBody.includes("data:image/png;base64,"));
    assert.deepEqual(result.messages.find((message) => message.role === "user")?.images, [image]);
    assert.ok(
      result.messages.some(
        (message) => message.role === "assistant" && message.text === "搭建建议",
      ),
    );
    assert.deepEqual(
      (await app.request("conversation.watch", { id: independent.id })).messages,
      [],
    );
    const fork = await app.request("conversation.fork", { id: first.id });
    assert.equal(
      (await app.request("conversation.watch", { id: fork.id })).messages.length,
      result.messages.length,
    );
    await app.close();
    app = await openApplication({ dataRoot: join(root, "data"), publish: () => {} });
    assert.equal((await app.request("workspace.get", {})).projects[0]?.id, project.id);
    const restored = await app.request("conversation.watch", { id: first.id });
    assert.equal(restored.messages.length, result.messages.length);
    assert.deepEqual(restored.messages.find((message) => message.role === "user")?.images, [image]);
    assert.deepEqual(
      (await app.request("conversation.watch", { id: independent.id })).messages,
      [],
    );
    assert.equal(
      (await app.request("conversation.watch", { id: fork.id })).messages.length,
      result.messages.length,
    );
    assert.equal(calls, 1);
  } finally {
    if (app) await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
