import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createLogins } from "../../../src/backend/settings/login.ts";
import { createProviders, modelChoice } from "../../../src/backend/settings/providers.ts";
import {
  type LoginInfo,
  type ProviderConfig,
  validateResult,
} from "../../../src/contracts/application.ts";

test("the provider catalogue covers every installed pi-ai provider and keeps its native login methods", () => {
  const providers = createProviders(new InMemoryCredentialStore());
  const catalog = providers.catalog();
  validateResult("provider.types", catalog);
  for (const native of builtinProviders()) {
    const entry = catalog.find((item) => item.id === native.id);
    assert.ok(entry);
    assert.equal(
      entry.methods.some((method) => method.id === "oauth"),
      !!native.auth.oauth,
    );
    assert.equal(
      entry.methods.some((method) => method.id === "api_key"),
      !!native.auth.apiKey?.login,
    );
    assert.equal(
      entry.methods.some((method) => method.id === "environment"),
      !!native.auth.apiKey,
    );
    validateResult("provider.models", native.getModels().slice(0, 1000).map(modelChoice));
  }
});

test("ChatGPT OAuth requests keep Pi's native request behavior with a configured provider ID", async () => {
  const native = builtinProviders().find((provider) => provider.id === "openai");
  const original = native?.getModels().find((model) => model.id === "gpt-6.2-sol");
  assert.ok(original);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("custom-openai-id", async () => ({
    type: "oauth",
    access: "fake-oauth-token",
    refresh: "fake-refresh-token",
    expires: Date.now() + 3_600_000,
  }));
  const providers = createProviders(credentials);
  providers.replace([
    {
      id: "custom-openai-id",
      name: "OpenAI",
      providerType: "openai",
      authMethod: "oauth",
      endpoint: "",
      enabled: true,

      models: [modelChoice(original)],
    },
  ]);
  const configured = providers.models.getModel("custom-openai-id", original.id);
  assert.ok(configured && configured.api === "openai-responses");
  let payload: Record<string, unknown> | undefined;
  await providers.models.completeSimple(
    configured,
    { messages: [{ role: "user", content: "test", timestamp: 1 }] },
    {
      maxTokens: 2048,
      reasoning: "high",
      onPayload(value) {
        payload = value as Record<string, unknown>;
        throw new Error("Stop before network");
      },
    },
  );
  assert.ok(payload);
  assert.equal(payload.max_output_tokens, undefined);
  assert.equal(payload.prompt_cache_options, undefined);
  assert.deepEqual(payload.reasoning, { effort: "high", summary: "auto" });
  assert.doesNotMatch(JSON.stringify(payload.input), /configuration_update/);

  providers.replace([
    {
      id: "api-key-openai-id",
      name: "OpenAI API",
      providerType: "openai",
      authMethod: "api_key",
      endpoint: "",
      enabled: true,

      models: [modelChoice(original)],
    },
  ]);
  const apiKeyModel = providers.models.getModel("api-key-openai-id", original.id);
  assert.deepEqual(apiKeyModel?.compat, original.compat);
});

test("Pi 1.6 GPT-6.2 models retain native capabilities with configured provider IDs", () => {
  const providers = createProviders(new InMemoryCredentialStore());
  for (const providerType of ["openai", "azure", "openai-codex"]) {
    const native = builtinProviders().find((provider) => provider.id === providerType);
    assert.ok(native);
    const models = native
      .getModels()
      .filter((model) => ["gpt-6.2-astra", "gpt-6.2-sol"].includes(model.id));
    assert.equal(models.length, 2);
    const id = `configured-${providerType}`;
    providers.replace([
      {
        id,
        name: native.name,
        providerType,
        authMethod: providerType === "openai-codex" ? "oauth" : "api_key",
        endpoint: "",
        enabled: true,
        models: models.map(modelChoice),
      },
    ]);
    for (const original of models) {
      const configured = providers.models.getModel(id, original.id);
      assert.ok(configured);
      assert.equal(configured.provider, id);
      assert.deepEqual(modelChoice(configured), modelChoice(original));
      const levels = modelChoice(configured).thinkingLevels;
      assert.ok(levels?.includes("max"));
      assert.ok(!levels?.includes("off"));
      if (providerType === "openai-codex")
        assert.equal(configured.thinkingLevelMap?.minimal, "low");
      else assert.ok(!levels?.includes("minimal"));
    }
  }
});

test("only opted-in native OpenAI models send Fast through Pi's agent runtime", async () => {
  const credentials = new InMemoryCredentialStore();
  const providers = createProviders(credentials);
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const account = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
    }),
  ).toString("base64url");
  for (const [providerType, authMethod, endpoint, expectedTier] of [
    ["openai", "api_key", "", "priority"],
    ["openai", "oauth", "", "priority"],
    ["openai-codex", "oauth", "", "priority"],
    ["openai", "api_key", "https://example.invalid/v1", undefined],
  ] as const) {
    const id = `configured-${providerType}-${authMethod}`;
    const native = builtinProviders().find((item) => item.id === providerType);
    assert.ok(native);
    const config: ProviderConfig = {
      id,
      name: native.name,
      providerType,
      authMethod,
      endpoint,
      enabled: true,
      models: native
        .getModels()
        .filter((model) => ["gpt-6.2-sol", "gpt-6.2-astra"].includes(model.id))
        .map((model) => ({
          ...modelChoice(model),
          ...(model.id === "gpt-6.2-sol" ? { fast: true } : {}),
        })),
    };
    await credentials.modify(id, async () =>
      authMethod === "oauth"
        ? {
            type: "oauth",
            access: `x.${account}.x`,
            refresh: "test",
            expires: Date.now() + 3_600_000,
          }
        : { type: "api_key", key: "test" },
    );
    runtime.registerNativeProvider(providers.create(config));
    for (const { id: modelId, fast } of config.models) {
      const model = runtime.getModel(id, modelId);
      assert.ok(model);
      let sent: Record<string, unknown> | undefined;
      await runtime.completeSimple(
        model,
        { messages: [{ role: "user", content: "test", timestamp: 1 }] },
        {
          transport: "sse",
          maxRetries: 0,
          onPayload: async (body) => ({ ...(body as object), instructions: "test override" }),
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const bytes = Buffer.from(await request.arrayBuffer());
            sent = JSON.parse(
              (request.headers.get("content-encoding") === "zstd"
                ? zstdDecompressSync(bytes)
                : bytes
              ).toString(),
            );
            return new Response("stop after recording serialized request", { status: 400 });
          },
        },
      );
      assert.ok(sent, `${id}:${modelId} did not reach mock transport`);
      assert.equal(sent.model, modelId);
      assert.equal(sent.instructions, "test override");
      assert.equal(sent.service_tier, fast ? expectedTier : undefined);
    }
    runtime.unregisterProvider(id);
  }
});

test("cancelled and superseded login attempts cannot publish or retain a credential", async () => {
  const events: LoginInfo[] = [];
  const logins = createLogins(
    createProviders(new InMemoryCredentialStore()),
    crypto.randomUUID(),
    (event) => events.push(event),
  );
  const first = logins.start("deepseek", "api_key");
  assert.equal(first.prompt?.type, "secret");
  const second = logins.start("deepseek", "api_key");
  assert.throws(() => logins.status(first.id), /授权尝试已结束/);
  assert.ok(second.prompt);
  assert.throws(() => logins.answer(second.id, "stale-prompt", "dummy-key"), /已失效/);
  logins.answer(second.id, second.prompt.id, "cancelled-test-key");
  logins.cancel(second.id);
  await setTimeout(0);
  assert.throws(() => logins.status(second.id), /授权尝试已结束/);
  assert.equal(
    events.filter((event) => event.id === second.id && event.status === "success").length,
    0,
  );
  assert.equal(JSON.stringify(events).includes("cancelled-test-key"), false);
  logins.close();
});
