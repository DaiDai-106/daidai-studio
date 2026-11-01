import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSettingsService } from "../../../src/backend/settings/service.ts";
import type { ProviderConfig } from "../../../src/contracts/application.ts";

const local: ProviderConfig = {
  id: "local-test",
  name: "Local",
  providerType: "local",
  authMethod: "none",
  endpoint: "http://127.0.0.1:11434/v1",
  enabled: true,

  models: [{ id: "example", name: "Example", context: 4096, output: 1024, reasoning: "标准" }],
};

test("启动不会读取旧设置文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-settings-legacy-"));
  try {
    await writeFile(
      join(root, "settings-v2.json"),
      JSON.stringify({
        version: 1,
        providers: [{ ...local, secretRef: "" }],
        defaultModel: "local-test:example",
        theme: "dark",
        showThinking: true,
        deviceId: "old",
      }),
    );
    const service = await createSettingsService({ dataRoot: root, publish: () => {} });
    assert.deepEqual((await service.info()).providers, []);
    assert.equal((await service.info()).theme, "light");
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model configuration survives restart and is registered with the Pi runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-model-settings-"));
  try {
    const events: string[] = [];
    const first = await createSettingsService({
      dataRoot: root,

      publish: (event) => events.push(event.type),
    });
    assert.equal((await first.info()).defaultModel, "");
    const saved = await first.handlers["provider.save"]({ config: local });
    assert.equal(saved.configured, true);
    assert.equal((await first.info()).defaultModel, "local-test:example");
    assert.equal(first.model("local-test:example")?.id, "example");
    assert.equal((await first.modelRuntime.getAuth("local-test"))?.auth.apiKey, "local");
    await first.handlers["settings.update"]({ theme: "dark", showThinking: false });
    await first.close();
    const second = await createSettingsService({ dataRoot: root, publish: () => {} });
    assert.equal((await second.info()).theme, "dark");
    assert.equal(second.model("local-test:example")?.baseUrl, local.endpoint);
    await assert.rejects(
      second.handlers["settings.update"]({ defaultModel: "missing:example" }),
      /有效模型/,
    );
    await second.handlers["provider.remove"]({ id: local.id });
    assert.equal((await second.info()).defaultModel, "");
    assert.equal(second.model("local-test:example"), undefined);
    assert.ok(events.includes("workspace"));
    assert.equal((await readFile(join(root, "settings.json"), "utf8")).includes("apiKey"), false);
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("本地凭据和设置可在重启后恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-model-secret-"));
  const config: ProviderConfig = {
    ...local,
    id: "secure-test",
    providerType: "compatible",
    authMethod: "api_key",
  };
  try {
    const first = await createSettingsService({ dataRoot: root, publish: () => {} });
    const login = await first.handlers["auth.start"]({
      providerType: "compatible",
      method: "api_key",
    });
    const prompt = (await first.handlers["auth.status"]({ id: login.id })).prompt;
    assert.ok(prompt);
    await first.handlers["auth.answer"]({
      id: login.id,
      promptId: prompt.id,
      value: "secret-value",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await first.handlers["auth.status"]({ id: login.id })).status, "success");
    await first.handlers["provider.save"]({ config, loginId: login.id });
    assert.ok((await readFile(join(root, "auth.json"), "utf8")).includes("secret-value"));
    assert.equal(
      (await readFile(join(root, "settings.json"), "utf8")).includes("secret-value"),
      false,
    );
    assert.equal((await first.modelRuntime.getAuth(config.id))?.auth.apiKey, "secret-value");
    await first.close();
    const second = await createSettingsService({ dataRoot: root, publish: () => {} });
    assert.equal((await second.modelRuntime.getAuth(config.id))?.auth.apiKey, "secret-value");
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured Pi model sends a real chat request using the selected provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-model-request-"));
  const originalFetch = globalThis.fetch;
  let request: { url: string; body: string; authorization: string | null } | undefined;
  globalThis.fetch = async (input, init) => {
    request = {
      url: String(input),
      body: String(init?.body),
      authorization: new Headers(init?.headers).get("authorization"),
    };
    const stream = [
      {
        id: "test",
        object: "chat.completion.chunk",
        created: 1,
        model: "example",
        choices: [
          { index: 0, delta: { role: "assistant", content: "测试回复" }, finish_reason: null },
        ],
      },
      {
        id: "test",
        object: "chat.completion.chunk",
        created: 1,
        model: "example",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ];
    return new Response(
      `${stream.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const service = await createSettingsService({ dataRoot: root, publish: () => {} });
    await service.handlers["provider.save"]({ config: local });
    const model = service.model("local-test:example");
    assert.ok(model);
    const reply = await service.modelRuntime.completeSimple(model, {
      messages: [{ role: "user", content: "你好", timestamp: Date.now() }],
    });
    assert.equal(reply.stopReason, "stop", reply.errorMessage);
    assert.ok(reply.content.some((part) => part.type === "text" && part.text === "测试回复"));
    assert.ok(request);
    assert.ok(request.url.endsWith("/chat/completions"));
    assert.match(request.body, /你好/);
    assert.equal(request.authorization, "Bearer local");
    await service.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
