import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../../src/backend/application.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";

test("场景引用只允许当前项目与当前版本，并实际进入模型上下文", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-scene-ref-"));
  const dataRoot = join(root, "data");
  const store = openProjectStore(dataRoot);
  const a = store.createProject({ name: "A", mode: "scene", path: root });
  const b = store.createProject({ name: "B", mode: "scene", path: root });
  const hash = "a".repeat(64);
  store.saveScene(a.id, 0, {
    models: [
      {
        source: { path: join(root, "missing.step"), sha256: hash },
        resource: { path: join(root, "model.glb"), format: "glb", byteLength: 4, sha256: hash },
        objects: [{ id: "object-1", name: "机械臂", parentId: null }],
        warnings: [],
        complete: true,
      },
    ],
  });
  store.close();
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? "");
    return new Response(
      'data: {"id":"r","object":"chat.completion.chunk","created":1,"model":"example","choices":[{"index":0,"delta":{"content":"收到"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const app = await openApplication({
    dataRoot,

    publish: (event) => {
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
          { id: "example", name: "Example", context: 4096, output: 1024, reasoning: "标准" },
        ],
      },
    });
    const model = (await app.request("scene.get", { projectId: a.id })).models[0];
    assert.ok(model);
    const first = await app.request("conversation.create", { projectId: a.id });
    const other = await app.request("conversation.create", { projectId: b.id });
    await assert.rejects(
      app.request("conversation.send", {
        id: first.id,
        requestId: "old",
        text: "操作它",
        sceneReference: { importId: model.id, objectId: "object-1", revision: 0 },
      }),
      /过期/,
    );
    await assert.rejects(
      app.request("conversation.send", {
        id: other.id,
        requestId: "other",
        text: "操作它",
        sceneReference: { importId: model.id, objectId: "object-1", revision: 0 },
      }),
      /当前项目|对象不存在/,
    );
    await app.request("conversation.send", {
      id: first.id,
      requestId: "ok",
      text: "操作它",
      sceneReference: { importId: model.id, objectId: "object-1", revision: 1 },
    });
    await done;
    assert.ok(requestBody.includes("object-1"));
    assert.ok(requestBody.includes("机械臂"));
    assert.ok(requestBody.includes(model.id));
    const inspector = openProjectStore(dataRoot);
    assert.equal(inspector.getConversation(first.id)?.hasMessages, true);
    inspector.close();
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
