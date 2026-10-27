import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openRuntime } from "../../src/backend/runtime.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

test("native thinking choices persist per conversation and reach DeepSeek tool rounds through Pi", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-thinking-"));
  const planner = await servePlanner((request) => {
    if (request.thinking?.type !== "enabled") return { text: "Reasoning disabled" };
    if (!turnResults(request).count)
      return {
        id: "read",
        name: "read",
        args: { path: join(root, "not-a-display.json") },
        thinking: "检查当前状态。",
      };
    return { text: "Reasoning and tools completed", thinking: "工具返回已检查。" };
  });
  let saved = "{}";
  const vault = {
    available: true,
    read: async () => saved,
    write: async (value: string) => {
      saved = value;
    },
  };
  let app = await openRuntime(root, vault, () => {});
  async function send(id: string) {
    await app.request("conversation.send", {
      id,
      requestId: crypto.randomUUID(),
      text: "Check reasoning",
    });
    for (let i = 0; i < 500; i++) {
      if (!(await app.request("workspace.get", {})).busyConversationId) return;
      await setTimeout(10);
    }
    assert.fail("Thinking run did not settle");
  }
  try {
    const login = await app.request("auth.start", { providerType: "deepseek", method: "api_key" });
    assert.ok(login.prompt);
    await app.request("auth.answer", {
      id: login.id,
      promptId: login.prompt.id,
      value: "isolated-test-key",
    });
    const config = {
      id: "native",
      providerType: "deepseek",
      name: "Native reasoning",
      authMethod: "api_key" as const,
      endpoint: planner.endpoint,
      enabled: true,
      persistCredentials: true,
      models: [],
    };
    const catalog = await app.request("provider.models", {
      config,
      loginId: login.id,
      discover: false,
    });
    const flash = catalog.find((model) => model.thinkingLevels?.includes("low"));
    const restricted = catalog.find(
      (model) => model.thinkingLevels?.includes("high") && !model.thinkingLevels?.includes("low"),
    );
    assert.ok(flash && restricted);
    await app.request("provider.save", {
      config: {
        ...config,
        models: [
          { ...flash, output: 4096 },
          { ...restricted, output: 4096 },
        ],
      },
      loginId: login.id,
    });
    const project = await app.request("project.open", { path: root });
    const a = await app.request("conversation.create", { projectId: project.id });
    const b = await app.request("conversation.create", { projectId: project.id });
    assert.equal(a.thinkingLevel, "off");
    const high = await app.request("conversation.update", {
      id: a.id,
      mode: "scene",
      thinkingLevel: "high",
    });
    assert.equal(high.thinkingLevel, "high");
    await send(a.id);
    assert.equal(planner.requests.length, 2);
    for (const request of planner.requests) {
      assert.equal(request.thinking?.type, "enabled");
      assert.equal(request.reasoning_effort, "high");
    }
    const view = await app.request("conversation.watch", { id: a.id });
    assert.ok(
      view.messages.some((message) =>
        message.blocks?.some((block) => block.kind === "thinking" && block.text),
      ),
    );
    assert.ok(view.messages.some((message) => message.tool?.name === "read"));
    assert.equal(
      (await app.request("workspace.get", {})).conversations.find((item) => item.id === b.id)
        ?.thinkingLevel,
      "off",
    );
    await send(b.id);
    assert.equal(planner.requests.at(-1)?.thinking?.type, "disabled");
    assert.equal(planner.requests.at(-1)?.reasoning_effort, undefined);
    await app.request("conversation.update", { id: a.id, modelId: `native:${restricted.id}` });
    await assert.rejects(
      app.request("conversation.update", { id: a.id, thinkingLevel: "low" }),
      /不支持/,
    );
    assert.equal(
      (await app.request("workspace.get", {})).conversations.find((item) => item.id === a.id)
        ?.thinkingLevel,
      "high",
    );
    await app.request("provider.save", {
      config: {
        id: "local",
        providerType: "local",
        name: "Text only",
        authMethod: "none",
        endpoint: planner.endpoint,
        enabled: true,
        persistCredentials: false,
        models: [{ id: "plain", name: "Plain", context: 128000, output: 1000, reasoning: "标准" }],
      },
    });
    assert.equal(
      (await app.request("conversation.update", { id: b.id, modelId: "local:plain" }))
        .thinkingLevel,
      "off",
    );
    await assert.rejects(
      app.request("conversation.update", { id: b.id, thinkingLevel: "high" }),
      /不支持/,
    );
    await app.close();
    app = await openRuntime(root, vault, () => {});
    const restored = (await app.request("workspace.get", {})).conversations;
    assert.equal(restored.find((item) => item.id === a.id)?.thinkingLevel, "high");
    assert.equal(restored.find((item) => item.id === b.id)?.thinkingLevel, "off");
    assert.deepEqual(planner.failures, []);
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
