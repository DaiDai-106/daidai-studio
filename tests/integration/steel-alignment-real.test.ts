import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openRuntime } from "../../src/backend/runtime.ts";
import { currentDisplayId, planCadImport, sceneContext } from "../support/cadPlan.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

const source = process.env.DAI_CAD_REAL_STEP;
const cad = process.env.DAI_CAD_TEST_WORKER;
const alignment = process.env.DAI_ALIGNMENT_TEST_WORKER;
// The source axes and approximate foot dimensions were identified from this assembly and its
// reference view. This scripted model verifies the tool chain, not real LLM visual recognition.
test("real steel assembly aligns and grounds four identified feet without shell", {
  skip: !source || !cad || !alignment,
  timeout: 240_000,
}, async () => {
  assert.ok(source && cad && alignment);
  const root = await mkdtemp(join(tmpdir(), "dai-steel-eval-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  const filename = basename(source);
  await copyFile(source, join(projectPath, filename));
  let alignmentStart = 0;
  let alignmentEnd = 0;
  let beforeGround: number[] = [];
  let calls = 0;
  const planner = await servePlanner((request) => {
    const results = turnResults(request);
    const state = sceneContext(request);
    const importId = currentDisplayId(request);
    const choose = (id: string, name: string, args: Record<string, unknown>) => {
      calls++;
      return { id, name, args };
    };
    if (!results.has("list")) return choose("list", "scene_list_steps", {});
    if (!results.has("select"))
      return choose("select", "scene_select_step", { relativePath: filename });
    if (!importId) {
      const planned = planCadImport(request, "preview", true);
      if (!planned) throw new Error("CAD display was not created");
      calls++;
      return planned;
    }
    const revision = state.currentDisplay?.placement.revision;
    assert.equal(typeof revision, "number");
    if (!alignmentStart) alignmentStart = Date.now();
    if (!results.has("inspect")) return choose("inspect", "scene_inspect", { importId, limit: 1 });
    if (!results.has("orient")) {
      const box = results.read<{ bounds: { min: number[]; max: number[] } }>("inspect").bounds;
      const center = box.min.map((value, index) => (value + (box.max[index] ?? 0)) / 2);
      return choose("orient", "alignment_align_frame", {
        importId,
        expectedRevision: revision,
        sourceUp: { kind: "world_axis", axis: "Y" },
        sourceForward: { kind: "world_axis", axis: "X" },
        anchor: "reference",
        sourceOrigin: { kind: "model_point", position: center },
        target: { origin: center, up: [0, 0, 1], forward: [0, 1, 0] },
      });
    }
    if (!results.has("lowest"))
      return choose("lowest", "scene_inspect", { importId, order: "lowest", limit: 50 });
    const lowest = results.read<{
      bounds: { min: number[] };
      objects: { objectId: string; bounds?: { min: number[]; max: number[] } }[];
    }>("lowest");
    const feet = lowest.objects
      .filter((item) => {
        if (!item.bounds) return false;
        const size = item.bounds.min.map((value, index) => (item.bounds?.max[index] ?? 0) - value);
        return (
          Math.abs((item.bounds.min[2] ?? 0) - (lowest.bounds.min[2] ?? 0)) < 1e-5 &&
          (size[0] ?? 0) > 0.17 &&
          (size[0] ?? 0) < 0.23 &&
          (size[1] ?? 0) > 0.17 &&
          (size[1] ?? 0) < 0.23 &&
          (size[2] ?? 0) > 0.01 &&
          (size[2] ?? 0) < 0.02
        );
      })
      .map((item) => item.objectId);
    assert.equal(feet.length, 4, "The reference assembly has four identified foot plates");
    if (!results.has("features"))
      return choose("features", "scene_get_features", {
        importId,
        objectIds: feet,
        type: "plane_center",
        limit: 50,
      });
    const data = results.read<{
      objects: {
        objectId: string;
        features: { featureId: string; origin: number[]; direction?: number[] }[];
      }[];
    }>("features");
    assert.ok(data.objects, JSON.stringify(data));
    const contacts = data.objects.map((item) => {
      const face = item.features
        .filter((feature) => (feature.direction?.[2] ?? 0) < -0.999)
        .sort((a, b) => (a.origin[2] ?? 0) - (b.origin[2] ?? 0))[0];
      assert.ok(face, `Missing horizontal foot face: ${item.objectId}`);
      return { objectId: item.objectId, featureId: face.featureId };
    });
    assert.equal(contacts.length, 4);
    if (!results.has("ground")) {
      beforeGround = [...(state.currentDisplay?.placement.translation ?? [])];
      return choose("ground", "alignment_ground", {
        importId,
        expectedRevision: revision,
        groundZ: 0,
        contacts,
      });
    }
    const grounded = results.read<{
      ok: boolean;
      data: {
        after: { placement: { translation: number[]; rotation: number[] } };
        groundContacts: { afterZ: number }[];
      };
    }>("ground");
    assert.equal(grounded.ok, true);
    assert.equal(grounded.data.groundContacts.length, 4);
    assert.ok(grounded.data.groundContacts.every((contact) => Math.abs(contact.afterZ) < 1e-6));
    assert.ok(
      Math.abs((grounded.data.after.placement.translation[0] ?? 0) - (beforeGround[0] ?? 0)) < 1e-8,
    );
    assert.ok(
      Math.abs((grounded.data.after.placement.translation[1] ?? 0) - (beforeGround[1] ?? 0)) < 1e-8,
    );
    for (const value of grounded.data.after.placement.rotation)
      assert.ok(Math.abs(value - 0.5) < 1e-8);
    alignmentEnd = Date.now();
    return { text: "四个已确认地脚的接触面均落在 Z=0。" };
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
    const started = Date.now();
    await app.request("conversation.send", {
      id: chat.id,
      requestId: "steel-eval",
      text: "解析型钢场景并对齐",
    });
    for (let i = 0; i < 4500; i++) {
      assert.deepEqual(planner.failures, []);
      if (!(await app.request("workspace.get", {})).busyConversationId) break;
      await setTimeout(50);
    }
    assert.equal(
      (await app.request("conversation.watch", { id: chat.id })).messages.at(-1)?.text,
      "四个已确认地脚的接触面均落在 Z=0。",
    );
    assert.deepEqual(planner.failures, []);
    console.log(
      JSON.stringify({
        metric: "steel_alignment",
        totalMs: Date.now() - started,
        alignmentMs: alignmentEnd - alignmentStart,
        toolCalls: calls,
        modelRequests: planner.requests.length,
        groundContacts: 4,
        shellCalls: 0,
      }),
    );
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
