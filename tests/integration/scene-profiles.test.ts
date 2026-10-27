import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openRuntime } from "../../src/backend/runtime.ts";
import { sceneContext } from "../support/cadPlan.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

test("scene onboarding asks once, loads the chosen MCP skill and preserves project and STEP choices", {
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-scene-profiles-"));
  const directory = join(root, "project");
  await mkdir(directory);
  await writeFile(join(directory, "first.step"), "STEP one");
  await writeFile(join(directory, "second.step"), "STEP two");
  const planner = await servePlanner((request) => {
    const user =
      request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
    const results = turnResults(request);
    const state = sceneContext(request);
    if (user.includes("应用事件：用户已进入场景搭建")) {
      assert.deepEqual(
        (request.tools ?? []).map((tool) => tool.function.name),
        ["scene_list_profiles"],
      );
      if (!results.has("profiles"))
        return { id: "profiles", name: "scene_list_profiles", args: {} };
      const list = results.read<{ profiles: { id: string; skillAvailable: boolean }[] }>(
        "profiles",
      );
      assert.equal(
        list.profiles.find((item) => item.id === "steel-structure")?.skillAvailable,
        true,
      );
      return { text: state.sceneProfileId ? "希望先做什么？" : "请问是什么场景，希望先做什么？" };
    }
    if (user === "型钢场景，先分析") {
      if (!results.has("select"))
        return {
          id: "select",
          name: "scene_select_profile",
          args: { profileId: "steel-structure", scope: "project" },
        };
      const selection = results.read<{ skill: string; skillAvailable: boolean }>("select");
      assert.equal(selection.skillAvailable, true);
      assert.match(selection.skill, /四个吊环/);
      assert.equal(state.sceneProfileId, "steel-structure");
      assert.equal(state.sceneProfileScope, "project");
      assert.match(
        JSON.stringify(request.messages.filter((message) => message.role === "system")),
        /当前业务场景：型钢场景/,
      );
      return { text: "已选择型钢场景。" };
    }
    if (user === "当前 STEP 使用焊接场景") {
      if (!results.has("select"))
        return {
          id: "select",
          name: "scene_select_profile",
          args: { profileId: "welding", scope: "source" },
        };
      assert.equal(results.read<{ skillAvailable: boolean }>("select").skillAvailable, false);
      assert.equal(state.sceneProfileId, "welding");
      assert.equal(state.sceneProfileScope, "source");
      assert.match(
        JSON.stringify(request.messages.filter((message) => message.role === "system")),
        /当前业务场景：焊接场景/,
      );
      assert.equal(state.sceneProfileSkillAvailable, false);
      return { text: "当前 STEP 使用焊接场景，尚无专用技能。" };
    }
    if (user === "检查自定义型钢技能") {
      assert.equal(state.sceneProfileId, "steel-structure");
      assert.match(
        JSON.stringify(request.messages.filter((message) => message.role === "system")),
        /用户型钢规则/,
      );
      return { text: "已加载用户规则。" };
    }
    if (user === "检查焊接场景") {
      assert.equal(state.sceneProfileId, "welding");
      assert.equal(state.sceneProfileSkillAvailable, false);
      return { text: "当前 STEP 是焊接场景。" };
    }
    assert.equal(user, "检查型钢场景");
    assert.equal(state.sceneProfileId, "steel-structure");
    return { text: "当前是型钢场景。" };
  });
  const vault = { available: false, read: async () => "{}", write: async () => {} };
  const paths = { skillsRoot: resolve("resources/skills") };
  let app = await openRuntime(root, vault, () => {}, paths);
  async function settled() {
    for (let i = 0; i < 1000; i++) {
      assert.deepEqual(planner.failures, []);
      if (!(await app.request("workspace.get", {})).busyConversationId) return;
      await setTimeout(10);
    }
    assert.fail("Scene run did not finish");
  }
  async function send(id: string, text: string) {
    await app.request("conversation.send", { id, requestId: crypto.randomUUID(), text });
    await settled();
  }
  try {
    await app.request("provider.save", {
      config: {
        id: "test",
        name: "Test",
        providerType: "local",
        endpoint: planner.endpoint,
        enabled: true,
        authMethod: "none",
        persistCredentials: false,
        models: [{ id: "test", name: "Test", context: 128000, output: 2048, reasoning: "标准" }],
      },
    });
    const project = await app.request("project.open", { path: directory });
    const first = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.update", { id: first.id, mode: "scene", draft: "保留草稿" });
    await app.request("conversation.startScene", { id: first.id });
    await settled();
    const intro = await app.request("conversation.watch", { id: first.id });
    assert.equal(intro.messages.filter((item) => item.role === "user").length, 0);
    assert.ok(intro.messages.some((item) => item.role === "event"));
    assert.equal(intro.messages.at(-1)?.text, "请问是什么场景，希望先做什么？");
    const initial = (await app.request("workspace.get", {})).conversations.find(
      (item) => item.id === first.id,
    );
    assert.equal(initial?.draft, "保留草稿");
    assert.equal(initial?.title, "新建对话");
    const count = planner.requests.length;
    await app.request("conversation.startScene", { id: first.id });
    assert.equal(planner.requests.length, count);
    await send(first.id, "型钢场景，先分析");
    const firstView = await app.request("conversation.watch", { id: first.id });
    assert.equal(
      firstView.messages.find((message) => message.tool?.name === "scene_select_profile")?.tool
        ?.serverName,
      "scene-profiles-mcp",
    );
    const next = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.update", { id: next.id, mode: "scene" });
    await app.request("conversation.startScene", { id: next.id });
    await settled();
    assert.equal(
      (await app.request("conversation.watch", { id: next.id })).messages.at(-1)?.text,
      "希望先做什么？",
    );
    await app.request("conversation.selectStep", { id: next.id, relativePath: "first.step" });
    await send(next.id, "当前 STEP 使用焊接场景");
    await app.request("conversation.selectStep", { id: next.id, relativePath: "second.step" });
    await send(next.id, "检查型钢场景");
    await app.request("skill.save", {
      config: {
        id: "user-steel",
        name: "用户型钢",
        description: "用户的型钢规则",
        body: "用户型钢规则",
        enabled: true,
        scope: { kind: "project", projectId: project.id },
        modes: ["scene"],
        sceneProfile: "steel-structure",
      },
    });
    await app.request("conversation.selectStep", { id: next.id, relativePath: "first.step" });
    await send(next.id, "检查焊接场景");
    await app.request("conversation.selectStep", { id: next.id, relativePath: "second.step" });
    await app.close();
    app = await openRuntime(root, vault, () => {}, paths);
    await send(next.id, "检查自定义型钢技能");
    assert.deepEqual(planner.failures, []);
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
