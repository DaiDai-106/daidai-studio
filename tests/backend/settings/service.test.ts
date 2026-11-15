import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("旧主题回退在写入队列内比较当前选择，不覆盖新主题且不保存比较条件", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-theme-compare-"));
  const service = await createSettingsService({ dataRoot: root, publish() {} });
  try {
    const update = service.handlers["settings.update"];
    await update({ desktopTheme: "theme:a" });
    const [selected, fallback] = await Promise.all([
      update({ desktopTheme: "theme:b" }),
      update({ desktopTheme: "", expectedDesktopTheme: "theme:a" }),
    ]);
    assert.equal(selected.desktopTheme, "theme:b");
    assert.equal(fallback.desktopTheme, "theme:b");
    await update({ desktopTheme: "", expectedDesktopTheme: "theme:b" });
    assert.equal((await service.info()).desktopTheme, "");
    const saved = JSON.parse(await readFile(join(root, "desktop/settings.json"), "utf8"));
    assert.equal(saved.desktopTheme, "");
    assert.equal(Object.hasOwn(saved, "expectedDesktopTheme"), false);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
    assert.equal(
      (await readFile(join(root, "agent", "settings.json"), "utf8")).includes("apiKey"),
      false,
    );
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
    assert.ok((await readFile(join(root, "agent", "auth.json"), "utf8")).includes("secret-value"));
    assert.equal(
      (await readFile(join(root, "agent", "settings.json"), "utf8")).includes("secret-value"),
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

test("仅保存桌面偏好时不写 Agent 配置，重启仍可恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-desktop-settings-"));
  let service = await createSettingsService({ dataRoot: root, publish() {} });
  try {
    await service.handlers["settings.update"]({ theme: "dark", showThinking: false });
    assert.deepEqual(await readdir(join(root, "agent")), []);
    await service.close();
    service = await createSettingsService({ dataRoot: root, publish() {} });
    assert.equal((await service.info()).theme, "dark");
    assert.equal((await service.info()).showThinking, false);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("桌面配置不可写不影响服务商凭据；Agent 保存失败保留旧认证且可重试", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-settings-write-failure-"));
  let service = await createSettingsService({ dataRoot: root, publish() {} });
  const config: ProviderConfig = { ...local, providerType: "compatible", authMethod: "api_key" };
  const agentPath = join(root, "agent/settings.json");
  const desktopPath = join(root, "desktop/settings.json");
  try {
    await mkdir(desktopPath);
    const login = await service.handlers["auth.start"]({
      providerType: "compatible",
      method: "api_key",
    });
    const prompt = (await service.handlers["auth.status"]({ id: login.id })).prompt;
    assert.ok(prompt);
    await service.handlers["auth.answer"]({ id: login.id, promptId: prompt.id, value: "test-key" });
    await new Promise((resolve) => setImmediate(resolve));
    await service.handlers["provider.save"]({ config, loginId: login.id });
    assert.equal((await service.modelRuntime.getAuth(config.id))?.auth.apiKey, "test-key");
    const previous = await readFile(agentPath, "utf8");
    const auth = await readFile(join(root, "agent/auth.json"), "utf8");
    await rm(agentPath);
    await mkdir(agentPath);
    await assert.rejects(
      service.handlers["provider.save"]({ config: { ...config, name: "changed" } }),
    );
    assert.equal((await service.info()).providers[0]?.name, config.name);
    assert.equal(await readFile(join(root, "agent/auth.json"), "utf8"), auth);
    assert.equal((await service.modelRuntime.getAuth(config.id))?.auth.apiKey, "test-key");
    await rm(agentPath, { recursive: true });
    await writeFile(agentPath, previous);
    await rm(desktopPath, { recursive: true });
    await service.close();
    service = await createSettingsService({ dataRoot: root, publish() {} });
    assert.equal((await service.modelRuntime.getAuth(config.id))?.auth.apiKey, "test-key");
    // 相同认证可复用，但更换服务地址后不能沿用旧凭据。
    await assert.rejects(
      service.handlers["provider.save"]({
        config: { ...config, endpoint: "http://127.0.0.1:9999/v1" },
      }),
      /认证/,
    );
    await service.handlers["provider.save"]({ config: { ...config, name: "changed" } });
    assert.equal((await service.info()).providers[0]?.name, "changed");
    assert.ok((await readdir(join(root, "agent"))).every((name) => !name.endsWith(".tmp")));
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("混合更新按归属提交，桌面失败后内存与磁盘保持一致并明确提示部分成功", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-mixed-settings-"));
  let service = await createSettingsService({ dataRoot: root, publish() {} });
  const desktopPath = join(root, "desktop/settings.json");
  try {
    await service.handlers["provider.save"]({ config: local });
    await service.handlers["provider.save"]({ config: { ...local, id: "second" } });
    await mkdir(desktopPath);
    await assert.rejects(
      service.handlers["settings.update"]({ defaultModel: "second:example", theme: "dark" }),
      /默认模型已保存，但桌面设置保存失败/,
    );
    assert.equal((await service.info()).defaultModel, "second:example");
    assert.equal((await service.info()).theme, "light");
    await rm(desktopPath, { recursive: true });
    await service.close();
    service = await createSettingsService({ dataRoot: root, publish() {} });
    assert.equal((await service.info()).defaultModel, "second:example");
    assert.equal((await service.info()).theme, "light");
    await service.handlers["settings.update"]({
      defaultModel: "local-test:example",
      theme: "dark",
    });
    await service.close();
    service = await createSettingsService({ dataRoot: root, publish() {} });
    assert.equal((await service.info()).defaultModel, "local-test:example");
    assert.equal((await service.info()).theme, "dark");
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
