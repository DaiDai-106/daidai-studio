import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
type Application = Awaited<ReturnType<typeof openApplication>>;

function waitForIdle(app: Application, id: string) {
  return until(async () => !(await app.request("conversation.watch", { id })).busy);
}

async function configure(app: Application, root: string) {
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

test("插件前置阶段可停止，且等待确认期间其他会话仍可发送", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-prompt-preflight-"));
  const dataRoot = join(root, "data");
  const source = join(root, "plugin");
  await mkdir(source);
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "preflight",
      pi: { extensions: ["index.ts"] },
    }),
  );
  await writeFile(
    join(source, "index.ts"),
    `
    export default pi => {
      pi.on("input", async (event, ctx) => {
        if (event.text === "输入钩子") await ctx.ui.confirm("等待输入", "继续吗？");
        return { action: "continue" };
      });
      pi.on("before_agent_start", async (event, ctx) => {
        if (event.prompt === "启动钩子") await ctx.ui.confirm("等待启动", "继续吗？");
      });
    };
  `,
  );
  await createPackageService({ dataRoot }).install(source, "global");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return response({ content: "完成" });
  };
  const app = await openApplication({ dataRoot, publish() {} });
  try {
    const { id, projectId } = await configure(app, root);
    for (const [index, text] of ["输入钩子", "启动钩子"].entries()) {
      await app.request("conversation.update", { id, draft: text });
      const submission = app.request("conversation.send", { id, requestId: `stop-${index}`, text });
      const cancelled = assert.rejects(submission, /发送已取消/);
      await until(
        async () =>
          (await app.request("workspace.get", {})).extensionUiRequests?.some(
            (request) => request.conversationId === id,
          ) ?? false,
      );
      assert.equal(requests, index);
      if (index === 0) {
        const other = await app.request("conversation.create", { projectId });
        await app.request("conversation.send", {
          id: other.id,
          requestId: "other",
          text: "另一条",
        });
        await waitForIdle(app, other.id);
      }
      await app.request("conversation.stop", { id });
      await cancelled;
      const view = await app.request("conversation.watch", { id });
      assert.equal(view.busy, false);
      assert.deepEqual(view.messages, []);
      assert.equal(requests, 1);
      const saved = (await app.request("workspace.get", {})).conversations.find((c) => c.id === id);
      assert.equal(saved?.draft, text);
      assert.equal(saved?.interrupted, false);
    }

    const next = app.request("conversation.send", { id, requestId: "confirmed", text: "启动钩子" });
    await until(async () => !!(await app.request("workspace.get", {})).extensionUiRequests?.length);
    await app.request("conversation.update", { id, draft: "等待确认时写的新草稿" });
    const request = (await app.request("workspace.get", {})).extensionUiRequests?.[0];
    assert.ok(request);
    await app.request("extension.ui.respond", {
      requestId: request.requestId,
      cancelled: false,
      value: "true",
    });
    assert.equal((await next).submissionId, "confirmed");
    await waitForIdle(app, id);
    assert.equal(requests, 2);
    const saved = (await app.request("workspace.get", {})).conversations.find((c) => c.id === id);
    assert.equal(saved?.draft, "等待确认时写的新草稿");
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("入队和清空草稿在同一事务，失败的提交可重试", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-queue-transaction-"));
  const dataRoot = join(root, "data");
  const first = Promise.withResolvers<void>();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    if (++requests === 1) await first.promise;
    return response({ content: "完成" });
  };
  const app = await openApplication({ dataRoot, publish() {} });
  const db = new DatabaseSync(join(dataRoot, "projects.sqlite"));
  try {
    const { id } = await configure(app, root);
    await app.request("conversation.send", { id, requestId: "first", text: "第一条" });
    await app.request("conversation.update", { id, draft: "第二条" });
    db.exec(`CREATE TRIGGER fail_draft_clear BEFORE UPDATE OF draft ON conversations
      WHEN OLD.draft <> '' AND NEW.draft = '' BEGIN SELECT RAISE(ABORT, '清空草稿失败'); END;`);
    const submission = { id, requestId: "queued", text: "第二条", delivery: "followUp" as const };
    await assert.rejects(app.request("conversation.send", submission), /清空草稿失败/);
    assert.deepEqual((await app.request("conversation.watch", { id })).queuedMessages, []);
    assert.equal((await app.request("workspace.get", {})).conversations[0]?.draft, "第二条");
    db.exec("DROP TRIGGER fail_draft_clear");
    assert.equal((await app.request("conversation.send", submission)).submissionId, "queued");
    first.resolve();
    await waitForIdle(app, id);
    const view = await app.request("conversation.watch", { id });
    assert.deepEqual(
      view.messages.filter((m) => m.role === "user").map((m) => m.text),
      ["第一条", "第二条"],
    );
    assert.equal(requests, 2);
  } finally {
    first.resolve();
    db.close();
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("工具边界插话优先，后续消息逐条处理；重复文本可独立取消", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-queue-"));
  const originalFetch = globalThis.fetch;
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
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
    await waitForIdle(app, id);
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
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
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
    await waitForIdle(app, id);
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
    await waitForIdle(app, id);
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
    await waitForIdle(app, id);
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
