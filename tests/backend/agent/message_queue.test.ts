import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Resvg } from "@resvg/resvg-js";
import { openApplication } from "../../../src/backend/application.ts";
import { createPackageService } from "../../../src/backend/extensions/package_service.ts";

const chunk = (delta: object, reason: string | null = null) =>
  `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "queue", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
const response = (delta: object, reason = "stop") =>
  new Response(`${chunk(delta)}${chunk({}, reason)}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail("等待队列状态超时");
}
async function configure(app: Awaited<ReturnType<typeof openApplication>>, root: string) {
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
          id: "queue",
          name: "Queue",
          context: 8192,
          output: 1024,
          reasoning: "标准",
          supportsImages: true,
        },
      ],
    },
  });
  const project = await app.request("project.create", { name: "P", mode: "coding", path: root });
  return app.request("conversation.create", { projectId: project.id });
}

test("工具边界插话优先，后续消息逐条处理；重复文本可独立取消", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-queue-"));
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)));
    if (requests.length === 1) {
      await gate;
      return response(
        {
          tool_calls: [
            {
              index: 0,
              id: "write1",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "result.txt", content: "ok" }),
              },
            },
          ],
        },
        "tool_calls",
      );
    }
    return response({ content: `回答 ${requests.length}` });
  };
  const app = await openApplication({ dataRoot: join(root, "data"), publish() {} });
  try {
    const chat = await configure(app, root);
    const id = chat.id;
    await app.request("conversation.send", { id, requestId: "initial", text: "开始" });
    await until(() => requests.length === 1);
    await app.request("conversation.send", {
      id,
      requestId: "follow",
      text: "最后总结",
      delivery: "followUp",
    });
    await app.request("conversation.send", {
      id,
      requestId: "steer1",
      text: "重复插话",
      delivery: "followUp",
      images: [
        {
          mimeType: "image/png",
          data: new Resvg(
            '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="100"><rect width="3000" height="100" fill="white"/></svg>',
          )
            .render()
            .asPng()
            .toString("base64"),
        },
      ],
    });
    await app.request("conversation.send", {
      id,
      requestId: "cancel",
      text: "重复插话",
      delivery: "steer",
    });
    await app.request("conversation.send", {
      id,
      requestId: "steer2",
      text: "第二条插话",
      delivery: "steer",
    });
    await app.request("conversation.promoteQueued", { id, messageId: "steer1" });
    await app.request("conversation.promoteQueued", { id, messageId: "steer1" });
    await app.request("conversation.cancelQueued", { id, messageId: "cancel" });
    await assert.rejects(
      app.request("conversation.promoteQueued", { id, messageId: "cancel" }),
      /已投递或取消/,
    );
    const pending = await app.request("conversation.watch", { id });
    assert.equal(pending.queuedMessages?.find((item) => item.id === "steer1")?.delivery, "steer");
    assert.deepEqual(
      pending.queuedMessages?.map((item) => item.id),
      ["follow", "steer1", "steer2"],
    );
    assert.deepEqual(
      pending.messages.filter((item) => item.role === "user").map((item) => item.text),
      ["开始"],
    );
    release();
    await until(async () => !(await app.request("conversation.watch", { id })).busy);
    const final = await app.request("conversation.watch", { id });
    assert.equal(final.error, "");
    assert.deepEqual(final.queuedMessages, []);
    assert.deepEqual(
      final.messages.filter((item) => item.role === "user").map((item) => item.text.split("\n")[0]),
      ["开始", "重复插话", "第二条插话", "最后总结"],
    );
    assert.equal(
      final.messages.find((item) => item.role === "user" && item.text.startsWith("重复插话"))
        ?.images?.length,
      1,
    );
    assert.ok(JSON.stringify(requests[1]).includes("image_url"));
    assert.equal(requests.length, 4);
    assert.ok(JSON.stringify(requests[1]).includes("重复插话"));
    assert.ok(!JSON.stringify(requests[1]).includes("最后总结"));
  } finally {
    release();
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("停止后队列和图片持久保留，重开不会自动发送，可显式继续", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-queue-reopen-"));
  const dataRoot = join(root, "data");
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    await Promise.race([
      gate,
      new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
    return response({ content: "完成" });
  };
  let app = await openApplication({ dataRoot, publish() {} });
  try {
    const chat = await configure(app, root);
    const id = chat.id;
    await app.request("conversation.send", { id, requestId: "initial", text: "开始" });
    await until(() => requests === 1);
    await app.request("conversation.send", {
      id,
      requestId: "saved",
      text: "恢复后执行",
      delivery: "followUp",
    });
    await app.request("conversation.send", {
      id,
      requestId: "image",
      text: "",
      delivery: "followUp",
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
    });
    await app.request("conversation.promoteQueued", { id, messageId: "image" });
    await app.request("conversation.stop", { id });
    await until(async () => !(await app.request("conversation.watch", { id })).busy);
    assert.equal((await app.request("conversation.watch", { id })).queuedMessages?.length, 2);
    await app.close();
    app = await openApplication({ dataRoot, publish() {} });
    const restored = await app.request("conversation.watch", { id });
    assert.equal(restored.busy, false);
    assert.equal(restored.queuedMessages?.find((item) => item.id === "image")?.imageCount, 1);
    assert.equal(requests, 1);
    assert.equal(restored.queuedMessages?.find((item) => item.id === "image")?.delivery, "steer");
    await assert.rejects(
      app.request("conversation.promoteQueued", { id, messageId: "saved" }),
      /当前会话未运行/,
    );
    await app.request("conversation.cancelQueued", { id, messageId: "image" });
    release();
    await app.request("conversation.resumeQueue", { id });
    await until(async () => !(await app.request("conversation.watch", { id })).busy);
    const final = await app.request("conversation.watch", { id });
    assert.deepEqual(final.queuedMessages, []);
    assert.ok(final.messages.some((item) => item.role === "user" && item.text === "恢复后执行"));
    assert.equal(requests, 2);
  } finally {
    release();
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("最后一个模型轮次已结束但运行尚未收尾时发送不丢失，仍按插话优先", {
  timeout: 15000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-queue-race-"));
  const dataRoot = join(root, "data");
  const source = join(root, "plugin");
  const marker = join(root, "settling");
  const gate = join(root, "release");
  await mkdir(source);
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "queue-race", pi: { extensions: ["index.ts"] } }),
  );
  await writeFile(
    join(source, "index.ts"),
    `
    import { existsSync, writeFileSync } from 'node:fs';
    import { setTimeout } from 'node:timers/promises';
    export default pi => {
      let ends = 0;
      pi.on('agent_end', async () => {
        if (++ends !== 1) return;
        writeFileSync(${JSON.stringify(marker)}, 'ready');
        while (!existsSync(${JSON.stringify(gate)})) await setTimeout(5);
      });
    }
  `,
  );
  await createPackageService({ dataRoot, moduleId: "coding" }).install(source, "module");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => response({ content: `回答 ${++requests}` });
  const app = await openApplication({ dataRoot, publish() {} });
  try {
    const { id } = await configure(app, root);
    await app.request("conversation.send", { id, requestId: "initial", text: "开始" });
    await until(() => existsSync(marker));
    await app.request("conversation.send", {
      id,
      requestId: "follow",
      text: "后续",
      delivery: "followUp",
    });
    await app.request("conversation.send", {
      id,
      requestId: "steer",
      text: "插话",
      delivery: "steer",
    });
    await writeFile(gate, "release");
    await until(async () => !(await app.request("conversation.watch", { id })).busy);
    const final = await app.request("conversation.watch", { id });
    assert.deepEqual(final.queuedMessages, []);
    assert.deepEqual(
      final.messages.filter((item) => item.role === "user").map((item) => item.text),
      ["开始", "插话", "后续"],
    );
    assert.equal(requests, 3);
  } finally {
    await writeFile(gate, "release");
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
