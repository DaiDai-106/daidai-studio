import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openRuntime } from "../../src/backend/runtime.ts";
import { SettingsDoc } from "../../src/backend/settings/documents.ts";
import { servePlanner } from "../support/planner.ts";

test("mode skills load on the first request despite legacy disabled flags, stay single and leave general chat", {
  timeout: 20_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-mode-skills-"));
  const storage = await openNodeSqliteStorage(join(root, "app.sqlite"));
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  await harness.commit(async (tx) => {
    (await tx.doc(SettingsDoc)).disabledCapabilities = [
      "builtin-scene",
      "builtin-alignment-skill",
      "builtin.cad",
    ];
  }, context);
  await harness.close(context);
  const bodies = await Promise.all(
    ["scene-building", "scene-alignment"].map((name) =>
      readFile(resolve("resources/skills", name, "SKILL.md"), "utf8"),
    ),
  );
  const planner = await servePlanner((request) => {
    const user = request.messages.filter((m) => m.role === "user").at(-1)?.content;
    const prompt = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    for (const body of bodies)
      assert.equal(prompt.split(body).length - 1, user === "ordinary" ? 0 : 1);
    assert.ok(
      (request.tools ?? []).every((tool) => !tool.function.name.startsWith("cad_")),
      "Automatic skills do not re-enable disabled tools",
    );
    return { text: "Checked" };
  });
  const app = await openRuntime(
    root,
    { available: false, read: async () => "{}", write: async () => {} },
    () => {},
  );
  try {
    assert.deepEqual((await app.request("workspace.get", {})).settings.disabledCapabilities, [
      "builtin.cad",
    ]);
    await app.request("provider.save", {
      config: {
        id: "local",
        name: "Test",
        providerType: "local",
        authMethod: "none",
        enabled: true,
        persistCredentials: false,
        endpoint: planner.endpoint,
        models: [{ id: "test", name: "Test", context: 128000, output: 1000, reasoning: "标准" }],
      },
    });
    const project = await app.request("project.open", { path: root });
    const id = (await app.request("conversation.create", { projectId: project.id })).id;
    await app.request("conversation.update", { id, mode: "scene" });
    await assert.rejects(
      app.request("capability.setEnabled", { id: "builtin-scene", enabled: false }),
      /随场景搭建模式/,
    );
    for (const text of ["first", "second", "ordinary"]) {
      if (text === "ordinary") await app.request("conversation.update", { id, mode: "general" });
      await app.request("conversation.send", { id, requestId: text, text });
      for (let i = 0; i < 500 && (await app.request("workspace.get", {})).busyConversationId; i++)
        await setTimeout(10);
      assert.equal((await app.request("workspace.get", {})).busyConversationId, null);
      assert.equal((await app.request("conversation.watch", { id })).error, "");
      assert.deepEqual(planner.failures, []);
    }
    assert.equal(planner.requests.length, 3);
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing builtin skill files fail scene requests explicitly before calling the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-missing-skills-"));
  const missing = join(root, "empty");
  await mkdir(missing);
  const app = await openRuntime(
    root,
    { available: false, read: async () => "{}", write: async () => {} },
    () => {},
    { skillsRoot: missing },
  );
  try {
    const project = await app.request("project.open", { path: root });
    const id = (await app.request("conversation.create", { projectId: project.id })).id;
    await app.request("conversation.update", { id, mode: "scene" });
    await assert.rejects(
      app.request("conversation.send", { id, requestId: "missing", text: "解析" }),
      /缺少基础技能 scene-building/,
    );
    assert.equal((await app.request("workspace.get", {})).busyConversationId, null);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
