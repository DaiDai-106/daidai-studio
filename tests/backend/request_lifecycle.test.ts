import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openApplication } from "../../src/backend/application.ts";
import type { BackendRequest } from "../../src/contracts/process.ts";
import { connectBackend } from "../../src/desktop/main/backend.ts";

test("模型发现等待网络时，项目写入仍可完成", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-discovery-queue-"));
  const app = await openApplication({ dataRoot: join(root, "data"), publish() {} });
  const fetching = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetching.resolve();
    return response.promise;
  };
  try {
    const models = app.request("provider.models", {
      discover: true,
      config: {
        id: "local",
        name: "Local",
        providerType: "local",
        authMethod: "none",
        endpoint: "http://127.0.0.1:11434/v1",
        enabled: true,
        models: [],
      },
    });
    await fetching.promise;
    const project = await app.request(
      "project.create",
      { name: "P", mode: "coding", path: root },
      Date.now() + 250,
    );
    assert.equal(project.name, "P");
    response.resolve(Response.json({ data: [{ id: "example" }] }));
    assert.equal((await models)[0]?.id, "example");
  } finally {
    response.resolve(Response.json({ data: [] }));
    globalThis.fetch = fetch;
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("排队超时的写入不会延迟提交，已开始的写入返回真实结果", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-request-timeout-"));
  const app = await openApplication({ dataRoot: join(root, "data"), publish() {} });
  const fetched = Promise.withResolvers<void>();
  const remote = Promise.withResolvers<Response>();
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched.resolve();
    return remote.promise;
  };
  try {
    const catalog = app.request(
      "catalog.install",
      {
        sourceId: "pi",
        id: "fixture-package",
        scope: "global",
        version: "1.0.0",
      },
      Date.now() + 100,
    );
    const catalogError = assert.rejects(
      catalog,
      (error: Error) => !error.message.includes("排队超时"),
    );
    await fetched.promise;
    const child = Object.assign(new EventEmitter(), {
      postMessage({ id, method, args }: BackendRequest) {
        void app.request(method, args, Date.now() + 25).then(
          (result) => child.emit("message", { type: "response", id, ok: true, result }),
          (error: Error) =>
            child.emit("message", { type: "response", id, ok: false, error: error.message }),
        );
      },
    });
    const backend = connectBackend(
      child as unknown as Parameters<typeof connectBackend>[0],
      () => {},
    );
    await assert.rejects(
      backend.request("project.create", {
        name: "过期项目",
        mode: "coding",
        path: root,
      }),
      /排队超时，未执行/,
    );
    await delay(100);
    remote.resolve(new Response(null, { status: 503 }));
    await catalogError;
    await app.request("project.create", { name: "正常项目", mode: "coding", path: root });
    assert.deepEqual(
      (await app.request("workspace.get", {})).projects.map(({ name }) => name),
      ["正常项目"],
    );
  } finally {
    remote.resolve(new Response(null, { status: 503 }));
    globalThis.fetch = fetch;
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("旧主题回退在写入队列内比较当前选择，不覆盖新主题且不保存比较条件", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-theme-compare-"));
  const dataRoot = join(root, "data");
  const app = await openApplication({ dataRoot, publish() {} });
  try {
    await app.request("settings.update", { desktopTheme: "theme:a" });
    const [selected, fallback] = await Promise.all([
      app.request("settings.update", { desktopTheme: "theme:b" }),
      app.request("settings.update", { desktopTheme: "", expectedDesktopTheme: "theme:a" }),
    ]);
    assert.equal(selected.desktopTheme, "theme:b");
    assert.equal(fallback.desktopTheme, "theme:b");
    const cleared = await app.request("settings.update", {
      desktopTheme: "",
      expectedDesktopTheme: "theme:b",
    });
    assert.equal(cleared.desktopTheme, "");
    const saved = JSON.parse(await readFile(join(dataRoot, "desktop/settings.json"), "utf8"));
    assert.equal(saved.desktopTheme, "");
    assert.equal(Object.hasOwn(saved, "expectedDesktopTheme"), false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
