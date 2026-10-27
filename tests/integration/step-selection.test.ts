import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openRuntime } from "../../src/backend/runtime.ts";
import { planCadImport, sceneContext } from "../support/cadPlan.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

test("scene plugin discovers and binds a STEP without requiring the picker", {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-step-selection-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  const filename = "26P03_01_0000 型钢切割系统.STEP";
  const deepStep = "deep/a/b/c/d/e/truncated.step";
  await writeFile(join(projectPath, filename), "test STEP");
  const planner = await servePlanner((request) => {
    const user = request.messages.filter((message) => message.role === "user").at(-1)?.content;
    const results = turnResults(request);
    const state = sceneContext(request);
    if (user === "解析场景") {
      if (!results.has("list")) {
        assert.equal(state.sourceStatus, "unselected");
        return { id: "list", name: "scene_list_steps", args: {} };
      }
      const list = results.read<{ files: string[]; complete: boolean }>("list");
      assert.deepEqual(list, { files: [filename], complete: true });
      if (!results.has("select"))
        return { id: "select", name: "scene_select_step", args: { relativePath: filename } };
      assert.equal(state.sourceStatus, "current");
      assert.equal(state.selectedSourcePath, join(projectPath, filename));
      assert.equal(
        results.read<{ selectedSourcePath: string }>("select").selectedSourcePath,
        state.selectedSourcePath,
      );
      return { text: "已选择 STEP，可以导入。" };
    }
    if (user === "另选文件") {
      if (!results.has("select"))
        return { id: "select", name: "scene_select_step", args: { relativePath: "other.step" } };
      assert.match(
        String(request.messages.findLast((message) => message.tool_call_id === "select")?.content),
        /已有选中的 STEP/,
      );
      assert.equal(state.selectedSourcePath, join(projectPath, filename));
      return { text: "请在界面切换。" };
    }
    if (user === "选择哪个") {
      if (!results.has("list")) return { id: "list", name: "scene_list_steps", args: {} };
      const list = results.read<{ files: string[]; complete: boolean }>("list");
      assert.equal(list.complete, true);
      assert.deepEqual(list.files, [filename, "other.step"]);
      assert.equal(state.sourceStatus, "unselected");
      return { text: "有两个 STEP，请选择。" };
    }
    if (user === "选择深层文件") {
      if (!results.has("list")) {
        assert.equal(state.sourceStatus, "unselected");
        return { id: "list", name: "scene_list_steps", args: {} };
      }
      const list = results.read<{ files: string[]; complete: boolean }>("list");
      assert.equal(list.complete, false);
      assert.ok(!list.files.includes(deepStep));
      if (!results.has("select-deep"))
        return {
          id: "select-deep",
          name: "scene_select_step",
          args: { relativePath: deepStep },
        };
      assert.equal(state.sourceStatus, "current");
      assert.equal(state.selectedSourcePath, join(projectPath, deepStep));
      return { text: "已选择深层 STEP。" };
    }
    assert.fail(`Unexpected user message: ${user}`);
  });
  const vault = { available: false, read: async () => "{}", write: async () => {} };
  let app = await openRuntime(root, vault, () => {});
  async function send(id: string, text: string) {
    await app.request("conversation.send", { id, requestId: crypto.randomUUID(), text });
    for (let i = 0; i < 1000; i++) {
      assert.deepEqual(planner.failures, []);
      if (!(await app.request("workspace.get", {})).busyConversationId) return;
      await setTimeout(10);
    }
    assert.fail("Model did not finish");
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
        models: [{ id: "test", name: "Test", context: 128000, output: 1024, reasoning: "标准" }],
      },
    });
    const project = await app.request("project.open", { path: projectPath });
    const first = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.update", { id: first.id, mode: "scene" });
    await send(first.id, "解析场景");
    const chosen = (await app.request("workspace.get", {})).conversations.find(
      (item) => item.id === first.id,
    )?.source;
    assert.equal(chosen?.relativePath, filename);
    await writeFile(join(projectPath, "other.step"), "other STEP");
    await send(first.id, "另选文件");
    const second = await app.request("conversation.create", { projectId: project.id });
    assert.equal(second.source?.id, chosen?.id);
    await app.request("conversation.selectStep", { id: second.id, relativePath: "" });
    await app.request("conversation.update", { id: second.id, mode: "scene" });
    await send(second.id, "选择哪个");
    assert.equal(
      (await app.request("workspace.get", {})).conversations.find((item) => item.id === second.id)
        ?.source,
      null,
    );
    await mkdir(join(projectPath, dirname(deepStep)), { recursive: true });
    await writeFile(join(projectPath, deepStep), "deep STEP");
    const refreshed = await app.request("project.refresh", { id: project.id });
    assert.equal(refreshed.filesComplete, false);
    assert.ok(!refreshed.files.includes(deepStep));
    const third = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.update", { id: third.id, mode: "scene" });
    await send(third.id, "选择深层文件");
    assert.equal(
      (await app.request("workspace.get", {})).conversations.find((item) => item.id === third.id)
        ?.source?.relativePath,
      deepStep,
    );
    await app.close();
    app = await openRuntime(root, vault, () => {});
    assert.equal(
      (await app.request("workspace.get", {})).conversations.find((item) => item.id === first.id)
        ?.source?.id,
      chosen?.id,
    );
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("does not persist a STEP when its existing source profile cannot be prepared", {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-step-profile-prepare-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  await writeFile(join(projectPath, "fixture.step"), "test STEP");
  const planner = await servePlanner((request) => {
    const user = request.messages.filter((message) => message.role === "user").at(-1)?.content;
    const results = turnResults(request);
    const state = sceneContext(request);
    if (user === "首次选择") {
      if (!results.has("select"))
        return { id: "select", name: "scene_select_step", args: { relativePath: "fixture.step" } };
      assert.equal(state.sourceStatus, "current");
      return { text: "已选择 STEP。" };
    }
    if (user === "设置源场景") {
      if (!results.has("profile")) {
        return {
          id: "profile",
          name: "scene_select_profile",
          args: { profileId: "source-profile", scope: "source" },
        };
      }
      assert.equal(state.sceneProfileId, "source-profile");
      assert.equal(state.sceneProfileScope, "source");
      return { text: "已设置源场景。" };
    }
    if (user === "再次选择") {
      if (!results.has("select")) {
        assert.equal(state.sourceStatus, "unselected");
        return { id: "select", name: "scene_select_step", args: { relativePath: "fixture.step" } };
      }
      const result = request.messages.findLast(
        (message) => message.tool_call_id === "select",
      )?.content;
      assert.match(String(result), /超过 64 KB/);
      assert.equal(state.sourceStatus, "unselected");
      return { text: "STEP 保持未选择。" };
    }
    assert.fail(`Unexpected user message: ${user}`);
  });
  const vault = { available: false, read: async () => "{}", write: async () => {} };
  const app = await openRuntime(root, vault, () => {});
  async function send(id: string, text: string) {
    await app.request("conversation.send", { id, requestId: crypto.randomUUID(), text });
    for (let i = 0; i < 1000; i++) {
      assert.deepEqual(planner.failures, []);
      if (!(await app.request("workspace.get", {})).busyConversationId) return;
      await setTimeout(10);
    }
    assert.fail("Model did not finish");
  }
  const sourceProfile = {
    id: "source-profile",
    name: "源专用场景",
    description: "仅用于验证已存在 STEP 的场景覆盖。",
    body: "初始场景规则",
    enabled: true,
    scope: { kind: "global" as const },
    modes: ["scene" as const],
    sceneProfile: "source-profile",
  };
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
        models: [{ id: "test", name: "Test", context: 128000, output: 1024, reasoning: "标准" }],
      },
    });
    const project = await app.request("project.open", { path: projectPath });
    await app.request("skill.save", { config: sourceProfile });
    const conversation = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.update", { id: conversation.id, mode: "scene" });
    await send(conversation.id, "首次选择");
    await send(conversation.id, "设置源场景");

    // Leave the source document (and its source-scoped profile) in place while
    // clearing the active selection, just as a user can do in the picker.
    await app.request("conversation.selectStep", { id: conversation.id, relativePath: "" });
    await app.request("skill.save", {
      config: { ...sourceProfile, body: "p".repeat(32_000) },
    });
    await app.request("skill.save", {
      config: {
        id: "base-profile-overflow",
        name: "通用规则",
        description: "使组合后的场景技能超出限制。",
        body: "b".repeat(32_000),
        enabled: true,
        scope: { kind: "global" },
        modes: ["scene"],
      },
    });
    await send(conversation.id, "再次选择");

    const workspace = await app.request("workspace.get", {});
    assert.equal(workspace.conversations.find((item) => item.id === conversation.id)?.source, null);
    const another = await app.request("conversation.create", { projectId: project.id });
    assert.equal(another.source, null);
    assert.deepEqual(planner.failures, []);
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});

const realStep = process.env.DAI_CAD_REAL_STEP;
const worker = process.env.DAI_CAD_TEST_WORKER;
test("selects and imports a real STEP without a preselected source", {
  skip: !realStep || !worker,
  timeout: 240_000,
}, async () => {
  assert.ok(realStep && worker);
  const root = await mkdtemp(join(tmpdir(), "dai-step-real-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  const filename = basename(realStep);
  await copyFile(realStep, join(projectPath, filename));
  const planner = await servePlanner((request) => {
    const results = turnResults(request);
    if (!results.has("list")) return { id: "list", name: "scene_list_steps", args: {} };
    if (!results.has("select")) {
      assert.deepEqual(results.read<{ files: string[]; complete: boolean }>("list"), {
        files: [filename],
        complete: true,
      });
      return { id: "select", name: "scene_select_step", args: { relativePath: filename } };
    }
    const planned = planCadImport(request, "preview", true);
    if (planned) return planned;
    assert.ok(sceneContext(request).currentDisplay, "CAD display must be published");
    return { text: "STEP 已解析并显示。" };
  });
  const app = await openRuntime(
    root,
    { available: false, read: async () => "{}", write: async () => {} },
    () => {},
    { nativeDirectory: dirname(worker) },
  );
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
    const project = await app.request("project.open", { path: projectPath });
    const chat = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.update", { id: chat.id, mode: "scene" });
    await app.request("conversation.send", { id: chat.id, requestId: "parse", text: "解析场景" });
    for (let i = 0; i < 4000; i++) {
      assert.deepEqual(planner.failures, []);
      if (!(await app.request("workspace.get", {})).busyConversationId) break;
      await setTimeout(50);
    }
    assert.equal(
      (await app.request("conversation.watch", { id: chat.id })).messages.at(-1)?.text,
      "STEP 已解析并显示。",
    );
    assert.ok(await app.request("display.get", { id: chat.id }));
    assert.deepEqual(planner.failures, []);
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
