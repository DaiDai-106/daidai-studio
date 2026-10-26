import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createLogins } from "../../../src/backend/settings/login.ts";
import { createProviders, modelChoice } from "../../../src/backend/settings/providers.ts";
import { type LoginInfo, validateResult } from "../../../src/shared/application.ts";

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
