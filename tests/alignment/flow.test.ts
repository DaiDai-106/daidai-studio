import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { readPlacement } from "../../resources/mcp/alignment/files.ts";
import { openRuntime } from "../../src/backend/runtime.ts";
import { currentDisplayId, planCadImport, sceneContext } from "../support/cadPlan.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

const executable = process.env.DAI_CAD_TEST_WORKER;
const fixture = process.env.DAI_CAD_TEST_FIXTURE;
const alignment = process.env.DAI_ALIGNMENT_TEST_WORKER;

test("Harness aligns saved CAD through independent stdio/C++, shares placement and restores global conversation order", {
  skip: !executable || !fixture || !alignment,
  timeout: 45_000,
}, async () => {
  assert.ok(executable && fixture && alignment);
  const root = await mkdtemp(join(tmpdir(), "dai-alignment-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  await promisify(execFile)(fixture, ["--write-fixture", join(projectPath, "assembly.step")]);
  const proposals: {
    before: { bounds: { min: number[]; max: number[] } };
    after: { bounds: { min: number[]; max: number[] } };
  }[] = [];
  const planner = await servePlanner((request) => {
    const results = turnResults(request);
    const importId = currentDisplayId(request);
    if (!importId) return planCadImport(request, "preview", true) ?? { text: "No display" };
    const user =
      request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
    const state = sceneContext(request);
    if (user.includes("旋转90")) {
      if (!results.has("rotate"))
        return {
          id: "rotate",
          name: "alignment_rotate",
          args: {
            importId,
            expectedRevision: state.currentDisplay?.placement?.revision,
            axis: [0, 0, 1],
            angleDegrees: 90,
            pivot: [0, 0, 0],
            space: "world",
          },
        };
      assert.equal(results.read<{ ok: boolean }>("rotate").ok, true);
      return { text: "Rotated" };
    }
    if (user.includes("重新定向")) {
      if (!results.has("frame"))
        return {
          id: "frame",
          name: "alignment_align_frame",
          args: {
            importId,
            expectedRevision: state.currentDisplay?.placement?.revision,
            sourceUp: { kind: "model_axis", axis: "Y" },
            sourceForward: { kind: "model_axis", axis: "X" },
            anchor: "min_corner",
            target: { origin: [0, 0, 0], up: [0, 0, 1], forward: [1, 0, 0] },
          },
        };
      assert.equal(results.read<{ ok: boolean }>("frame").ok, true);
      return { text: "Oriented" };
    }
    if (user.includes("过期版本")) {
      if (!results.has("stale"))
        return {
          id: "stale",
          name: "alignment_rotate",
          args: {
            importId,
            expectedRevision: 0,
            axis: [0, 0, 1],
            angleDegrees: 90,
            pivot: [0, 0, 0],
            space: "world",
          },
        };
      assert.equal(
        results.read<{ error: { code: string } }>("stale").error.code,
        "REVISION_CONFLICT",
      );
      return { text: "Conflict rejected" };
    }
    const ctx = sceneContext(request);
    if (!results.has("read-manifest"))
      return { id: "read-manifest", name: "read", args: { path: ctx.files?.manifest, limit: 15 } };
    if (!results.has("read-features"))
      return { id: "read-features", name: "read", args: { path: ctx.files?.features, limit: 3 } };
    if (!results.has("read-denied"))
      return { id: "read-denied", name: "read", args: { path: join(root, "app.sqlite") } };
    assert.ok(
      request.messages.some(
        (message) =>
          message.tool_call_id === "read-features" && message.content?.includes('"featureId"'),
      ),
      "Pi read must return real cached CAD feature records, not just an empty header",
    );
    assert.ok(
      request.messages.some(
        (message) =>
          message.tool_call_id === "read-denied" &&
          message.content?.includes("READ_PATH_NOT_AUTHORIZED"),
      ),
    );
    if (!results.has("bounds"))
      return { id: "bounds", name: "alignment_get_bounds", args: { importId: importId } };
    if (!results.has("align"))
      return {
        id: "align",
        name: "alignment_align_min_corner",
        args: { importId: importId, expectedRevision: ctx.currentDisplay?.placement?.revision },
      };
    proposals.push(results.read<{ data: (typeof proposals)[number] }>("align").data);
    return { text: "Aligned" };
  });
  const vault = { available: false, read: async () => "{}", write: async () => {} };
  const paths = {
    cadExecutable: executable,
    alignmentExecutable: alignment,
    skillsRoot: resolve("resources/skills"),
  };
  let app = await openRuntime(root, vault, () => {}, paths);
  async function send(id: string, requestId: string, text = "将整套装配包围盒最小角点对齐原点") {
    await app.request("conversation.send", {
      id,
      requestId,
      text,
    });
    for (let i = 0; i < 400; i++) {
      if (!(await app.request("workspace.get", {})).busyConversationId) return;
      await setTimeout(10);
    }
    assert.fail("Alignment never settled");
  }
  try {
    await app.request("provider.save", {
      config: {
        id: "align-test",
        name: "Test",
        providerType: "local",
        endpoint: planner.endpoint,
        enabled: true,
        authMethod: "none",
        persistCredentials: false,
        models: [{ id: "test", name: "test", context: 128000, output: 2048, reasoning: "标准" }],
      },
    });
    const project = await app.request("project.open", { path: projectPath });
    const a = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.update", { id: a.id, mode: "scene" });
    await app.request("conversation.selectStep", { id: a.id, relativePath: "assembly.step" });
    await send(a.id, "first");
    const first = await app.request("display.get", { id: a.id });
    assert.ok(first?.placement && first.placement.revision > 0);
    assert.equal(proposals.length, 1);
    for (const value of proposals[0]?.after.bounds.min ?? []) assert.ok(Math.abs(value) < 1e-8);
    const originalManifest = await readFile(
      join(root, "projects", project.id, "artifacts", first.importId, "manifest.json"),
    );
    const manifest = JSON.parse(originalManifest.toString("utf8"));
    assert.ok(manifest.features.objects.some((item: { count: number }) => item.count > 0));
    const b = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.update", { id: b.id, mode: "scene" });
    assert.deepEqual((await app.request("display.get", { id: b.id }))?.placement, first.placement);
    await rm(join(projectPath, "assembly.step"));
    await send(b.id, "second");
    await send(a.id, "third");
    let current = await app.request("display.get", { id: a.id });
    assert.ok(current?.placement && current.placement.revision > first.placement.revision);
    assert.deepEqual(
      current.placement.translation,
      first.placement.translation,
      "Repeated alignment must not accumulate translation",
    );
    assert.equal(current.importId, first.importId);
    assert.deepEqual(
      await readFile(
        join(root, "projects", project.id, "artifacts", first.importId, "manifest.json"),
      ),
      originalManifest,
    );
    assert.equal(proposals.length, 3);
    for (const result of proposals.slice(1))
      for (const value of result.before.bounds.min) assert.ok(Math.abs(value) < 1e-8);
    assert.deepEqual(
      await readPlacement(join(root, "projects", project.id), current.importId, current.sourceHash),
      current.placement,
    );
    await send(a.id, "rotate", "旋转90");
    const rotated = await app.request("display.get", { id: a.id });
    assert.ok(rotated?.placement);
    assert.ok(Math.abs(rotated.placement.rotation[2] - Math.SQRT1_2) < 1e-8);
    await send(b.id, "frame", "重新定向");
    const oriented = await app.request("display.get", { id: b.id });
    assert.ok(oriented?.placement);
    assert.ok(Math.abs(oriented.placement.rotation[0] - Math.SQRT1_2) < 1e-8);
    await send(a.id, "stale", "过期版本");
    assert.deepEqual(
      (await app.request("display.get", { id: a.id }))?.placement,
      oriented.placement,
    );
    current = oriented;
    const calls = planner.requests.length;
    await app.close();
    await rm(join(root, "projects", project.id, "placements"), { recursive: true, force: true });
    app = await openRuntime(root, vault, () => {}, paths);
    assert.deepEqual(
      (await app.request("display.get", { id: b.id }))?.placement,
      current.placement,
      "Recovery must merge A/B/A results in global entry order",
    );
    assert.equal(
      planner.requests.length,
      calls,
      "Placement recovery must not replay model or MCP calls",
    );
    assert.deepEqual(planner.failures, []);
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
