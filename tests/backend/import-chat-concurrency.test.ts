import { strict as assert } from "node:assert";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";

test("同项目导入和聊天互斥，跨项目可并发", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-import-chat-"));
  const dataRoot = join(root, "data");
  const originalFetch = globalThis.fetch;
  let releaseFetch: (() => void) | undefined;
  let called: (() => void) | undefined;
  const calledPromise = new Promise<void>((resolveCalled) => {
    called = resolveCalled;
  });
  globalThis.fetch = async () => {
    called?.();
    await new Promise<void>((resolveFetch) => {
      releaseFetch = resolveFetch;
    });
    return new Response(
      'data: {"id":"r","object":"chat.completion.chunk","created":1,"model":"example","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const app = await openApplication({
    dataRoot,
    pythonExecutable: "python3",
    workerPath: resolve("tests/backend/fixtures/hanging-import-worker.py"),

    publish: () => {},
  });
  try {
    const a = await app.request("project.create", { name: "A", mode: "scene", path: root });
    const b = await app.request("project.create", { name: "B", mode: "scene", path: root });
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
    const ca = await app.request("conversation.create", { projectId: a.id });
    const cb = await app.request("conversation.create", { projectId: b.id });
    const input = (projectId: string) => ({
      projectId,
      path: join(root, "source.step"),
      operation: "replace" as const,
      revision: 0,
    });
    const importA = app.request("scene.import", input(a.id));
    const rejectedA = assert.rejects(importA, /取消|abort/i);
    for (let tries = 0; tries < 100; tries++) {
      try {
        await access(join(dataRoot, "projects", a.id, "scene", "import-started"));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    await assert.rejects(
      app.request("conversation.send", { id: ca.id, requestId: "a1", text: "hello" }),
      /导入/,
    );
    await app.request("conversation.send", { id: cb.id, requestId: "b1", text: "hello" });
    await calledPromise;
    await assert.rejects(app.request("scene.import", input(b.id)), /会话|聊天/);
    await app.request("scene.cancelImport", { projectId: a.id });
    await rejectedA;
    const importA2 = app.request("scene.import", input(a.id));
    const rejectedA2 = assert.rejects(importA2, /取消|abort/i);
    await app.request("scene.cancelImport", { projectId: a.id });
    await rejectedA2;
    releaseFetch?.();
    let stopped = false;
    for (let tries = 0; tries < 100; tries++) {
      if (!(await app.request("conversation.watch", { id: cb.id })).busy) {
        stopped = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(stopped, true);
    const importB = app.request("scene.import", input(b.id));
    const rejectedB = assert.rejects(importB, /取消|abort/i);
    await app.request("scene.cancelImport", { projectId: b.id });
    await rejectedB;
  } finally {
    releaseFetch?.();
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
