import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../../src/backend/application.ts";

test("Pi 流式思考在回答完成前通过 partialBlocks 推送", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-thinking-stream-"));
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "example", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              chunk({ role: "assistant", reasoning_content: "正在分析" }, null),
            ),
          );
          await gate;
          controller.enqueue(
            new TextEncoder().encode(
              `${chunk({ content: "结论" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
            ),
          );
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  let thinking!: () => void;
  const observed = new Promise<void>((resolve) => {
    thinking = resolve;
  });
  let completed!: () => void;
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  let sawThinking = false;
  let emptyTransition = false;
  const app = await openApplication({
    dataRoot: join(root, "data"),

    publish: (event) => {
      if (event.type === "conversation") {
        if (
          event.view.busy &&
          event.view.activity === "thinking" &&
          event.view.partialBlocks?.some(
            (block) => block.kind === "thinking" && block.text === "正在分析",
          )
        ) {
          sawThinking = true;
          thinking();
        }
        if (
          sawThinking &&
          event.view.busy &&
          !event.view.partialBlocks?.some((block) => block.kind === "thinking") &&
          !event.view.messages.some((message) =>
            message.blocks?.some((block) => block.kind === "thinking"),
          )
        )
          emptyTransition = true;
        if (!event.view.busy) completed();
      }
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
          { id: "example", name: "Example", context: 4096, output: 1024, reasoning: "标准" },
        ],
      },
    });
    const project = await app.request("project.create", {
      name: "通用",
      mode: "general",
      path: root,
    });
    const conversation = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.send", {
      id: conversation.id,
      requestId: "request",
      text: "问题",
    });
    await observed;
    release();
    await done;
    const restored = await app.request("conversation.watch", { id: conversation.id });
    assert.equal(emptyTransition, false);
    assert.ok(
      restored.messages.some((message) =>
        message.blocks?.some((block) => block.kind === "thinking" && block.text === "正在分析"),
      ),
    );
  } finally {
    release();
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
