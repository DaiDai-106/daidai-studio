import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import type { SceneContext } from "../../src/backend/agent/types.ts";
import { openRuntime } from "../../src/backend/runtime.ts";
import { currentDisplayId, planCadImport } from "../support/cadPlan.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

const executable = process.env.DAI_CAD_TEST_WORKER;
const fixture = process.env.DAI_CAD_TEST_FIXTURE;
const alignment = process.env.DAI_ALIGNMENT_TEST_WORKER;

test("reimport publishes its identity to the model; stale targets and paths return current state for rotation without another import", {
  skip: !executable || !fixture || !alignment,
  timeout: 30_000,
}, async () => {
  assert.ok(executable && fixture && alignment);
  const root = await mkdtemp(join(tmpdir(), "dai-scene-target-"));
  const path = join(root, "project");
  await mkdir(path);
  const step = join(path, "assembly.step");
  await promisify(execFile)(fixture, ["--write-fixture", step]);
  const ids: string[] = [];
  let recovered: SceneContext | undefined;
  let sceneRoot = "";
  const planner = await servePlanner((request) => {
    const results = turnResults(request);
    const user = request.messages.filter((message) => message.role === "user").at(-1)?.content;
    if (user === "导入" || user === "重新导入") {
      const planned = planCadImport(request, "preview", true);
      if (planned) return planned;
      const id = currentDisplayId(request);
      assert.ok(id);
      // This diagnostic is durable's supported model-visible channel, not UI-only details.
      const output =
        request.messages.filter((message) => message.tool_call_id === "cad-display-wait").at(-1)
          ?.content ?? "";
      assert.ok(output.includes(`"importId":"${id}"`));
      const diagnostic = output.slice(output.indexOf("<harness>"));
      assert.ok(
        diagnostic.includes(id),
        "The persistent ID must reach the model beside the CAD result",
      );
      ids.push(id);
      return { text: "Display published" };
    }
    assert.equal(user, "绕世界X轴+90度");
    const oldId = ids[0];
    assert.ok(oldId);
    if (!results.has("old-target"))
      return { id: "old-target", name: "alignment_get_bounds", args: { importId: oldId } };
    const old = results.read<{ ok: boolean; error: { code: string }; scene: SceneContext }>(
      "old-target",
    );
    assert.equal(old.ok, false);
    assert.equal(old.error.code, "SCENE_TARGET_CHANGED");
    assert.equal(old.scene.currentDisplay?.importId, ids[1]);
    assert.ok(old.scene.currentDisplay);
    if (!results.has("old-path"))
      return {
        id: "old-path",
        name: "read",
        args: { path: join(sceneRoot, "artifacts", oldId, "manifest.json"), limit: 5 },
      };
    const denied = results.read<{ error: { code: string }; scene: SceneContext }>("old-path");
    assert.equal(denied.error.code, "READ_PATH_NOT_AUTHORIZED");
    assert.equal(denied.scene.currentDisplay?.importId, ids[1]);
    assert.equal(
      denied.scene.files?.manifest,
      join(sceneRoot, "artifacts", ids[1] ?? "", "manifest.json"),
    );
    recovered = denied.scene;
    if (!results.has("relative-path"))
      return {
        id: "relative-path",
        name: "read",
        args: { path: `.daidai/artifacts/${ids[1]}/manifest.json`, limit: 5 },
      };
    const relative = results.read<{ error: { code: string }; scene: SceneContext }>(
      "relative-path",
    );
    assert.equal(relative.error.code, "ABSOLUTE_PATH_REQUIRED");
    assert.equal(relative.scene.files?.manifest, denied.scene.files?.manifest);
    if (!results.has("rotate"))
      return {
        id: "rotate",
        name: "alignment_rotate",
        args: {
          importId: old.scene.currentDisplay.importId,
          expectedRevision: old.scene.currentDisplay.placement.revision,
          axis: [1, 0, 0],
          angleDegrees: 90,
          pivot: [0, 0, 0],
          space: "world",
        },
      };
    assert.equal(results.read<{ ok: boolean }>("rotate").ok, true);
    return { text: "Current model rotated" };
  });
  const app = await openRuntime(
    root,
    { available: false, read: async () => "{}", write: async () => {} },
    () => {},
    {
      cadExecutable: executable,
      alignmentExecutable: alignment,
      skillsRoot: resolve("resources/skills"),
    },
  );
  async function send(id: string, text: string) {
    await app.request("conversation.send", { id, requestId: crypto.randomUUID(), text });
    for (let i = 0; i < 400; i++) {
      assert.deepEqual(planner.failures, []);
      if (!(await app.request("workspace.get", {})).busyConversationId) return;
      await setTimeout(10);
    }
    assert.fail("Scene target recovery did not settle");
  }
  try {
    await app.request("provider.save", {
      config: {
        id: "target",
        name: "Target test",
        providerType: "local",
        authMethod: "none",
        endpoint: planner.endpoint,
        enabled: true,
        persistCredentials: false,
        models: [{ id: "test", name: "test", context: 128000, output: 2048, reasoning: "标准" }],
      },
    });
    const project = await app.request("project.open", { path });
    sceneRoot = join(root, "projects", project.id);
    const conversation = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.update", { id: conversation.id, mode: "scene" });
    await app.request("conversation.selectStep", {
      id: conversation.id,
      relativePath: "assembly.step",
    });
    await send(conversation.id, "导入");
    await send(conversation.id, "重新导入");
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    const manifest = join(sceneRoot, "artifacts", ids[1] ?? "", "manifest.json");
    const original = await readFile(manifest);
    await rm(step);
    await send(conversation.id, "绕世界X轴+90度");
    const model = await app.request("display.get", { id: conversation.id });
    assert.equal(model?.importId, ids[1]);
    assert.ok(model?.placement && model.placement.revision > 0);
    assert.ok(Math.abs(model.placement.rotation[0] - Math.SQRT1_2) < 1e-8);
    assert.equal(recovered?.sourceStatus, "missing");
    assert.deepEqual(await readFile(manifest), original);
    assert.equal((await readdir(join(sceneRoot, "artifacts"))).length, 2);
    const latest = planner.requests.filter(
      (request) =>
        request.messages.filter((message) => message.role === "user").at(-1)?.content ===
        "绕世界X轴+90度",
    );
    assert.ok(latest.length > 0);
    const last = latest.at(-1);
    assert.ok(last);
    const tools = turnResults(last);
    assert.equal(
      tools.count,
      4,
      "Only stale-target, stale-path and relative-path probes plus one rotation; no reimport or read loop",
    );
    assert.deepEqual(planner.failures, []);
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
