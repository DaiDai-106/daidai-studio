import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { openRuntime } from "../../src/backend/runtime.ts";
import { currentDisplayId, planCadImport, sceneContext } from "../support/cadPlan.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

const cad = process.env.DAI_CAD_TEST_WORKER,
  fixture = process.env.DAI_CAD_TEST_FIXTURE,
  alignment = process.env.DAI_ALIGNMENT_TEST_WORKER;
test("one Harness run imports, rotates and grounds with fresh revisions; stale calls expose current placement", {
  skip: !cad || !fixture || !alignment,
  timeout: 30_000,
}, async () => {
  assert.ok(cad && fixture && alignment);
  const root = await mkdtemp(join(tmpdir(), "dai-sequence-")),
    project = join(root, "project");
  await mkdir(project);
  const source = join(project, "assembly.step");
  await promisify(execFile)(fixture, ["--write-fixture", source]);
  const original = await readFile(source);
  const revisions: number[] = [];
  const planner = await servePlanner((request) => {
    const results = turnResults(request),
      importId = currentDisplayId(request),
      state = sceneContext(request);
    if (!importId) return planCadImport(request, "preview", true) ?? { text: "Missing display" };
    const revision = state.currentDisplay?.placement?.revision;
    assert.equal(typeof revision, "number");
    if (!results.has("rotate")) {
      revisions.push(revision ?? -1);
      return {
        id: "rotate",
        name: "alignment_rotate",
        args: {
          importId,
          expectedRevision: revision,
          axis: [1, 0, 0],
          angleDegrees: 90,
          pivot: [0, 0, 0],
          space: "world",
        },
      };
    }
    assert.equal(results.read<{ ok: boolean }>("rotate").ok, true);
    if (!results.has("ground")) {
      assert.ok(
        (revision ?? 0) > (revisions[0] ?? 0),
        "Next model request must see the committed rotation revision",
      );
      revisions.push(revision ?? -1);
      return {
        id: "ground",
        name: "alignment_align_min_corner",
        args: { importId, expectedRevision: revision },
      };
    }
    const grounded = results.read<{ ok: boolean; data: { after: { bounds: { min: number[] } } } }>(
      "ground",
    );
    assert.equal(grounded.ok, true);
    for (const value of grounded.data.after.bounds.min) assert.ok(Math.abs(value) < 1e-8);
    if (!results.has("stale"))
      return {
        id: "stale",
        name: "alignment_rotate",
        args: {
          importId,
          expectedRevision: 0,
          axis: [1, 0, 0],
          angleDegrees: 90,
          pivot: [0, 0, 0],
          space: "world",
        },
      };
    const stale = results.read<{
      ok: boolean;
      error: { code: string };
      currentPlacement: { revision: number };
    }>("stale");
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, "REVISION_CONFLICT");
    assert.equal(stale.currentPlacement.revision, revision);
    assert.ok((revision ?? 0) > (revisions[1] ?? 0));
    return { text: "Imported, rotated and grounded" };
  });
  const app = await openRuntime(
    root,
    { available: false, read: async () => "{}", write: async () => {} },
    () => {},
    { cadExecutable: cad, alignmentExecutable: alignment, skillsRoot: resolve("resources/skills") },
  );
  try {
    await app.request("provider.save", {
      config: {
        id: "test",
        providerType: "local",
        name: "Scripted workflow",
        authMethod: "none",
        endpoint: planner.endpoint,
        enabled: true,
        persistCredentials: false,
        models: [{ id: "test", name: "Test", context: 128000, output: 1000, reasoning: "标准" }],
      },
    });
    const p = await app.request("project.open", { path: project });
    const c = await app.request("conversation.create", { projectId: p.id });
    await app.request("conversation.update", { id: c.id, mode: "scene" });
    await app.request("conversation.selectStep", { id: c.id, relativePath: "assembly.step" });
    await app.request("conversation.send", {
      id: c.id,
      requestId: crypto.randomUUID(),
      text: "解析，然后绕世界X轴90度并将包围盒最小角点归零",
    });
    for (let i = 0; i < 1000; i++) {
      if (!(await app.request("workspace.get", {})).busyConversationId) break;
      await setTimeout(10);
    }
    assert.equal((await app.request("workspace.get", {})).busyConversationId, null);
    const view = await app.request("conversation.watch", { id: c.id });
    assert.equal(view.messages.at(-1)?.text, "Imported, rotated and grounded");
    assert.equal(view.messages.filter((message) => message.role === "user").length, 1);
    assert.deepEqual(planner.failures, []);
    const model = await app.request("display.get", { id: c.id });
    assert.ok(model?.placement && model.placement.revision > 0);
    assert.ok(Math.abs(Math.abs(model.placement.rotation[0]) - Math.SQRT1_2) < 1e-8);
    assert.ok((await readFile(source)).equals(original));
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
