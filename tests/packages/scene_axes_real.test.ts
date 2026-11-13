import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createSceneRuntime, type SceneImportResult } from "../../packages/scene/src/runtime.ts";
import { compareCylinderAxes } from "../../packages/scene/src/world.ts";

const python = process.env.DAI_SCENE_TEST_PYTHON;
test("真实 STEP 父级旋转与不同实例轴比较只返回未确认几何证据", {
  timeout: 30_000,
  skip: python ? false : "需要配置 DAI_SCENE_TEST_PYTHON",
}, async () => {
  assert.ok(python);
  const directory = await mkdtemp(join(tmpdir(), "dai-real-axes-"));
  const source = join(directory, "axes.step");
  const runtime = createSceneRuntime({
    projectId: "axes",
    cwd: directory,
    dataDir: join(directory, "data"),
    pythonExecutable: python,
  });
  try {
    await promisify(execFile)(python, [
      "-c",
      "import sys;sys.path.insert(0,sys.argv[1]);from assembly_fixture import write_cylinder_relations;write_cylinder_relations(sys.argv[2])",
      resolve("tests/python"),
      source,
    ]);
    const sourceBefore = await readFile(source);
    const result = (await runtime.call("scene_import", { path: source })) as SceneImportResult;
    const byName = (name: string) => {
      const object = result.objects.find((item) => item.name === name);
      assert.ok(object);
      const candidate = object.cylinderCandidates?.[0];
      assert.ok(candidate);
      return {
        modelId: "model-a",
        objects: result.objects,
        objectId: object.id,
        faceIndex: candidate.faceIndex,
      };
    };
    const a = byName("AxisA"),
      b = byName("AxisB"),
      offset = byName("Offset"),
      rotated = byName("Rotated"),
      opposite = byName("Opposite");
    const tolerance = { angleRad: 0.001, distanceM: 0.0001 };
    const match = compareCylinderAxes(a, b, tolerance);
    assert.equal(match.withinTolerance, true);
    assert.equal(match.space, "world-z-up");
    assert.equal(match.connection, "unverified");
    assert.equal(match.offsetDefinition, "second-origin-to-first-infinite-axis");
    assert.equal(match.jointType, "unknown");
    assert.equal(match.jointLimits, "unknown");
    assert.ok(match.angleRad < 1e-6 && match.axisOffsetM < 1e-6);
    assert.ok(Math.abs(Math.abs(match.first.direction[0]) - 1) < 1e-6);
    const displaced = compareCylinderAxes(a, offset, tolerance);
    assert.equal(displaced.withinTolerance, false);
    assert.ok(Math.abs(displaced.axisOffsetM - 0.01) < 1e-6);
    const angled = compareCylinderAxes(a, rotated, tolerance);
    assert.equal(angled.withinTolerance, false);
    assert.ok(Math.abs(angled.angleRad - Math.PI / 2) < 1e-6);
    const reverse = compareCylinderAxes(a, opposite, tolerance);
    assert.equal(reverse.withinTolerance, true);
    assert.ok(reverse.angleRad < 1e-6);
    const movedObjects = result.objects.map((object) =>
      object.id === b.objectId
        ? {
            ...object,
            transform: {
              position: [0.005, 0, 0.04] as [number, number, number],
              rotation: object.baseTransform.rotation,
            },
          }
        : object,
    );
    const moved = compareCylinderAxes(
      { ...a, objects: movedObjects },
      { ...b, objects: movedObjects },
      tolerance,
    );
    assert.ok(Math.abs(moved.axisOffsetM - 0.005) < 1e-6);
    assert.equal(moved.withinTolerance, false);
    const broken = {
      ...a,
      objects: result.objects.map((object) =>
        object.id === a.objectId ? { ...object, rigidTransform: false } : object,
      ),
    };
    assert.throws(() => compareCylinderAxes(broken, b, tolerance), /缩放|刚体/);
    assert.throws(() => compareCylinderAxes(a, a, tolerance), /不同对象/);
    // 相同源对象 ID 在不同模型实例中也属于不同场景对象。
    assert.equal(
      compareCylinderAxes(a, { ...a, modelId: "model-b" }, tolerance).withinTolerance,
      true,
    );
    assert.throws(() => compareCylinderAxes(a, b, { angleRad: NaN, distanceM: 0 }), /容差/);
    assert.deepEqual(await readFile(source), sourceBefore);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
