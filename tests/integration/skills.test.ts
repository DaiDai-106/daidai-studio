import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openRuntime } from "../../src/backend/runtime.ts";
import type { SkillConfig } from "../../src/shared/capabilities.ts";
import { servePlanner } from "../support/planner.ts";

test("custom skills persist and reach only their project and mode without granting tools or retaining disabled instructions", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-skills-"));
  const planner = await servePlanner((request) => {
    const user = request.messages.filter((message) => message.role === "user").at(-1)?.content;
    const prompt = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    assert.equal(prompt.includes("general-skill-marker"), user === "general-a");
    assert.equal(prompt.includes("private-skill-a-marker"), user === "scene-a");
    assert.equal(prompt.includes("private-skill-b-marker"), user === "scene-b");
    assert.equal(prompt.includes("disabled-skill-marker"), false);
    assert.deepEqual(
      request.tools ?? [],
      [],
      "A skill cannot grant tools, including when CAD is unavailable",
    );
    return { text: "Skill scope checked." };
  });
  const vault = { available: false, read: async () => "{}", write: async () => {} };
  let app = await openRuntime(root, vault, () => {});
  async function send(id: string, text: string) {
    await app.request("conversation.send", { id, requestId: crypto.randomUUID(), text });
    for (let index = 0; index < 200; index++) {
      if (!(await app.request("workspace.get", {})).busyConversationId) return;
      await setTimeout(10);
    }
    assert.fail("Skill turn did not finish");
  }
  try {
    await app.request("provider.save", {
      config: {
        id: "skills",
        providerType: "local",
        name: "Skill test",
        authMethod: "none",
        endpoint: planner.endpoint,
        enabled: true,
        persistCredentials: false,
        models: [
          { id: "skill-test", name: "Skill", context: 128000, output: 1000, reasoning: "标准" },
        ],
      },
    });
    const pathA = join(root, "a"),
      pathB = join(root, "b");
    await mkdir(pathA);
    await mkdir(pathB);
    const a = await app.request("project.open", { path: pathA }),
      b = await app.request("project.open", { path: pathB });
    const skill = (
      id: string,
      body: string,
      modes: SkillConfig["modes"],
      projectId?: string,
    ): SkillConfig => ({
      id,
      name: id,
      description: "Workflow guidance",
      body,
      enabled: true,
      modes,
      scope: projectId ? { kind: "project", projectId } : { kind: "global" },
    });
    const general = skill("general", "general-skill-marker", ["general"]);
    const sceneA = skill("scene-a", "private-skill-a-marker", ["scene"], a.id);
    const sceneB = skill("scene-b", "private-skill-b-marker", ["scene"], b.id);
    for (const config of [
      general,
      sceneA,
      sceneB,
      { ...skill("disabled", "disabled-skill-marker", ["scene", "general"]), enabled: false },
    ])
      await app.request("skill.save", { config });
    await assert.rejects(
      app.request("skill.save", { config: { ...general, id: "builtin-scene" } }),
      /内置/,
    );
    await assert.rejects(
      app.request("skill.save", { config: { ...general, body: "  " } }),
      /不能为空/,
    );
    await assert.rejects(
      app.request("skill.save", {
        config: { ...general, scope: { kind: "project", projectId: "missing" } },
      }),
      /项目/,
    );
    const chatA = (await app.request("conversation.create", { projectId: a.id })).id;
    await send(chatA, "general-a");
    await app.request("conversation.update", { id: chatA, mode: "scene" });
    await send(chatA, "scene-a");
    const chatB = (await app.request("conversation.create", { projectId: b.id })).id;
    await app.request("conversation.update", { id: chatB, mode: "scene" });
    await send(chatB, "scene-b");
    await app.request("skill.save", { config: { ...sceneA, enabled: false } });
    await send(chatA, "scene-a-disabled");
    assert.deepEqual(planner.failures, []);
    for (let index = 0; index < 3; index++)
      await app.request("skill.save", {
        config: skill(`large-${index}`, "x".repeat(32000), ["scene"], a.id),
      });
    const count = planner.requests.length;
    await assert.rejects(
      app.request("conversation.send", {
        id: chatA,
        requestId: "too-large",
        text: "Should not start",
      }),
      /64 KB/,
    );
    assert.equal(planner.requests.length, count);
    assert.equal((await app.request("workspace.get", {})).busyConversationId, null);
    for (let index = 0; index < 3; index++)
      await app.request("skill.remove", { id: `large-${index}` });
    const saved = (await app.request("workspace.get", {})).settings.skills;
    await app.close();
    app = await openRuntime(root, vault, () => {});
    assert.deepEqual((await app.request("workspace.get", {})).settings.skills, saved);
    await app.request("skill.remove", { id: sceneB.id });
    await send(chatB, "scene-b-removed");
    assert.deepEqual(planner.failures, []);
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
