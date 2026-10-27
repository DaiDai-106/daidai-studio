import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const executable = process.env.DAI_ALIGNMENT_TEST_WORKER;
function glb(invalidIndex = false, cycle = false) {
  const positions = Buffer.alloc(48);
  [-1, -2, -3, 2, 4, 6, 0, 3, 4, 999, 999, 999].forEach((value, i) => {
    positions.writeFloatLE(value, i * 4);
  });
  const indices = Buffer.alloc(8);
  [0, 1, invalidIndex ? 4 : 2].forEach((value, i) => {
    indices.writeUInt16LE(value, i * 2);
  });
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [
        { translation: [5, 6, 7], children: cycle ? [0] : [1, 2] },
        { mesh: 0, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], extras: { objectId: "part" } },
        {
          mesh: 0,
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1],
          extras: { objectId: "other" },
        },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
      buffers: [{ byteLength: 56 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 48 },
        { buffer: 0, byteOffset: 48, byteLength: 6 },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 4,
          type: "VEC3",
          min: [-1, -2, -3],
          max: [999, 999, 999],
        },
        { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
      ],
    }),
  );
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const result = Buffer.alloc(12 + 8 + padded.length + 8 + 56);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(result, 20);
  const offset = 20 + padded.length;
  result.writeUInt32LE(56, offset);
  result.writeUInt32LE(0x004e4942, offset + 4);
  positions.copy(result, offset + 8);
  indices.copy(result, offset + 56);
  return result;
}
type NativeResult = {
  before: {
    placement: { translation: number[]; rotation: number[] };
    bounds: { min: number[]; max: number[] };
  };
  after: {
    placement: { translation: number[]; rotation: number[] };
    bounds: { min: number[]; max: number[] };
  };
  resolvedSourceFrame?: { origin: number[]; up: number[]; forward: number[] };
  resolvedDirection?: {
    source: number[];
    target: number[];
    axis: number[];
    pivot: number[];
    angleDegrees: number;
  };
  space?: string;
  total?: number;
  nextOffset?: number;
  featureCacheComplete?: boolean;
  displayComplete?: boolean;
  features?: {
    objectId: string;
    featureId: string;
    origin: number[];
    direction?: number[];
    radius?: number;
  }[];
  objects?: {
    objectId: string;
    total?: number;
    features?: { featureId: string; origin: number[]; direction?: number[] }[];
    nextOffset?: number;
    bounds?: { min: number[]; max: number[] };
  }[];
  groundContacts?: { objectId: string; featureId: string; beforeZ: number; afterZ: number }[];
};
async function compute(
  path: string,
  translation: number[],
  args: Record<string, unknown> = {},
  operation = "alignment_align_min_corner",
  extra: Record<string, unknown> = {},
) {
  assert.ok(executable);
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.resume();
  const done = new Promise<NativeResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? (() => {
            const envelope = JSON.parse(output);
            if (envelope.ok) resolve(envelope.data);
            else reject(new Error(`${envelope.error.code}: ${envelope.error.message}`));
          })()
        : reject(new Error("Invalid geometry")),
    );
  });
  child.stdin.end(
    `${JSON.stringify({ glbPath: path, displayToScene: { translation: [0, 0, 2], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: [1, 1, 1] }, manifestPath: "", placement: { translation, rotation: [0, 0, 0, 1] }, operation, arguments: args, ...extra })}\n`,
  );
  return done;
}
test("native alignment uses triangle vertices, composed transforms and repeated instances without rewriting geometry", {
  skip: !executable,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-native-align-")),
    path = join(root, "model.glb");
  try {
    const bytes = glb();
    await writeFile(path, bytes);
    const result = await compute(path, [3, -5, 2]);
    function close(actual: number[], expected: number[]) {
      actual.forEach((value, i) => {
        assert.ok(Math.abs(value - (expected[i] ?? 0)) < 1e-8, `${actual} != ${expected}`);
      });
    }
    close(result.before.bounds.min, [4, -18, 8]);
    close(result.before.bounds.max, [20, -9, 14]);
    close(result.after.placement.translation, [-1, 13, -6]);
    close(result.after.bounds.min, [0, 0, 0]);
    close(result.after.bounds.max, [16, 9, 6]);
    const again = await compute(path, result.after.placement.translation);
    close(again.after.placement.translation, result.after.placement.translation);
    close(again.before.bounds.min, [0, 0, 0]);
    assert.deepEqual(await readFile(path), bytes);
    await writeFile(path, glb(true));
    await assert.rejects(compute(path, [0, 0, 0]), /INVALID_RESOURCE/);
    await writeFile(path, glb(false, true));
    await assert.rejects(compute(path, [0, 0, 0]), /INVALID_RESOURCE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function near(actual: number[], expected: number[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => {
    assert.ok(Math.abs(value - (expected[i] ?? 0)) < 1e-8, `${actual} != ${expected}`);
  });
}
test("native alignment solves absolute frames, world/model pivot rotation and cached instance-local features", {
  skip: !executable,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-align-frames-"));
  const path = join(root, "model.glb");
  try {
    await writeFile(path, glb());
    const target = { origin: [0, 0, 0], up: [0, 0, 1], forward: [1, 0, 0] };
    const frame = {
      sourceUp: { kind: "model_axis", axis: "Y" },
      sourceForward: { kind: "model_axis", axis: "X" },
      anchor: "min_corner",
      target,
    };
    const aligned = await compute(path, [3, -5, 2], frame, "alignment_align_frame");
    near(aligned.after.bounds.min, [0, 0, 0]);
    near(aligned.after.bounds.max, [16, 6, 9]);
    near(aligned.after.placement.rotation, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    const oneDirection = {
      sourceDirection: { kind: "model_axis", axis: "Y" },
      targetDirection: [0, 0, 1],
      pivot: { kind: "world_point", position: [0, 0, 0] },
    };
    const directionResult = await compute(
      path,
      [3, -5, 2],
      oneDirection,
      "alignment_align_direction",
    );
    near(directionResult.after.placement.rotation, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    near(directionResult.after.placement.translation, [3, -2, -5]);
    const opposite = await compute(
      path,
      [0, 0, 0],
      {
        ...oneDirection,
        targetDirection: [0, -1, 0],
      },
      "alignment_align_direction",
    );
    near(opposite.after.placement.rotation, [0, 0, -1, 0]);
    const centered = await compute(
      path,
      [3, -5, 2],
      {
        ...oneDirection,
        pivot: { kind: "bounds_center" },
      },
      "alignment_align_direction",
    );
    const center = (box: NativeResult["before"]["bounds"]) =>
      box.min.map((x, i) => (x + (box.max[i] ?? 0)) / 2);
    near(center(centered.after.bounds), center(centered.before.bounds));
    await assert.rejects(
      compute(
        path,
        [0, 0, 0],
        {
          ...oneDirection,
          targetDirection: [0, 0, 0],
        },
        "alignment_align_direction",
      ),
      /INVALID_ARGUMENT/,
    );
    const repeated = await compute(
      path,
      aligned.after.placement.translation,
      frame,
      "alignment_align_frame",
      { placement: aligned.after.placement },
    );
    near(repeated.after.placement.translation, aligned.after.placement.translation);
    near(repeated.after.placement.rotation, aligned.after.placement.rotation);
    const relative = { axis: [0, 0, 1], angleDegrees: 90, pivot: [1, 2, 3], space: "world" };
    const rotated = await compute(path, [3, -5, 2], relative, "alignment_rotate");
    near(rotated.after.placement.translation, [8, 4, 2]);
    near(rotated.after.placement.rotation, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    const inverse = await compute(
      path,
      [0, 0, 0],
      { ...relative, angleDegrees: -90 },
      "alignment_rotate",
      { placement: rotated.after.placement },
    );
    near(inverse.after.placement.translation, [3, -5, 2]);
    near(inverse.after.placement.rotation, [0, 0, 0, 1]);
    const modelSpace = await compute(
      path,
      [0, 0, 0],
      { ...relative, space: "model" },
      "alignment_rotate",
      { placement: aligned.after.placement },
    );
    // Model-space rotation composes on the right, including its original model-space pivot.
    const restored = await compute(
      path,
      [0, 0, 0],
      { ...relative, angleDegrees: -90, space: "model" },
      "alignment_rotate",
      { placement: modelSpace.after.placement },
    );
    near(restored.after.placement.translation, aligned.after.placement.translation);
    near(restored.after.placement.rotation, aligned.after.placement.rotation);
    const bad = { ...frame, sourceForward: { kind: "model_axis", axis: "Y" } };
    await assert.rejects(
      compute(path, [0, 0, 0], bad, "alignment_align_frame"),
      /DEGENERATE_FRAME/,
    );
    await assert.rejects(
      compute(path, [0, 0, 0], { ...relative, axis: [0, 0, 0] }, "alignment_rotate"),
      /INVALID_ARGUMENT/,
    );
    await assert.rejects(
      compute(path, [0, 0, 0], { objectId: "missing" }, "alignment_get_bounds"),
      /OBJECT_NOT_FOUND/,
    );
    const manifestPath = join(root, "manifest.json"),
      featuresPath = join(root, "features.jsonl");
    const source = { sourceHash: "a".repeat(64), importFingerprint: "b".repeat(64) };
    await writeFile(
      manifestPath,
      JSON.stringify({
        source,
        complete: true,
        features: {
          objects: [
            { objectId: "part", analysisComplete: true },
            { objectId: "scaled", analysisComplete: false },
          ],
        },
        objects: [
          {
            objectId: "parent",
            localTransform: {
              translation: [10, 20, 30],
              rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
              scale: [1, 1, 1],
            },
          },
          {
            objectId: "part",
            parentObjectId: "parent",
            localTransform: { translation: [2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          {
            objectId: "scaled",
            parentObjectId: "parent",
            localTransform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 1] },
          },
        ],
      }),
    );
    await writeFile(
      featuresPath,
      `${[
        JSON.stringify({ schemaVersion: 1, ...source, unit: "m", space: "object" }),
        JSON.stringify({
          objectId: "part",
          featureId: "up",
          type: "plane_center",
          origin: [1, 0, 0],
          direction: [0, 0, 1],
        }),
        JSON.stringify({
          objectId: "part",
          featureId: "front",
          type: "plane_center",
          origin: [1, 0, 0],
          direction: [1, 0, 0],
        }),
        JSON.stringify({
          objectId: "part",
          featureId: "high",
          type: "plane_center",
          origin: [1, 0, 0.1],
          direction: [0, 0, 1],
        }),
        JSON.stringify({
          objectId: "scaled",
          featureId: "oblique",
          type: "plane_center",
          origin: [0, 0, 0],
          direction: [1, 1, 0],
        }),
        JSON.stringify({
          objectId: "part",
          featureId: "hole",
          type: "cylinder_axis",
          origin: [1, 0, 0],
          direction: [0, 0, 1],
          radius: 0.05,
        }),
      ].join("\n")}\n`,
    );
    const reference = {
      sourceUp: { kind: "cad_feature", objectId: "part", featureId: "up" },
      sourceForward: { kind: "cad_feature", objectId: "part", featureId: "front" },
      anchor: "reference",
      sourceOrigin: { kind: "cad_feature", objectId: "part", featureId: "up" },
      target,
    };
    const exact = await compute(path, [0, 0, 0], reference, "alignment_align_frame", {
      manifestPath,
      featuresPath,
    });
    near(exact.resolvedSourceFrame?.origin ?? [], [10, 23, 30]);
    near(exact.after.placement.translation, [-23, 10, -30]);
    const featureDirection = await compute(
      path,
      [0, 0, 0],
      {
        sourceDirection: { kind: "cad_feature", objectId: "part", featureId: "front" },
        targetDirection: [0, 0, 1],
        pivot: { kind: "world_point", position: [0, 0, 0] },
      },
      "alignment_align_direction",
      {
        manifestPath,
        featuresPath,
        placement: { translation: [0, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
      },
    );
    near(featureDirection.resolvedDirection?.source ?? [], [-1, 0, 0]);
    near(featureDirection.resolvedDirection?.target ?? [], [0, 0, 1]);
    const worldDirection = await compute(
      path,
      [0, 0, 0],
      {
        sourceDirection: { kind: "world_axis", axis: "Y", reverse: true },
        targetDirection: [0, 0, 1],
        pivot: { kind: "bounds_center" },
      },
      "alignment_align_direction",
      { placement: { translation: [3, -5, 2], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } },
    );
    near(worldDirection.resolvedDirection?.source ?? [], [0, -1, 0]);
    const worldFrame = await compute(
      path,
      [0, 0, 0],
      {
        sourceUp: { kind: "world_axis", axis: "Z" },
        sourceForward: { kind: "world_axis", axis: "Y" },
        anchor: "reference",
        sourceOrigin: { kind: "model_point", position: [0, 0, 0] },
        target: { origin: [3, -5, 2], up: [0, 0, 1], forward: [0, 1, 0] },
      },
      "alignment_align_frame",
      { placement: { translation: [3, -5, 2], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } },
    );
    near(worldFrame.after.placement.translation, [3, -5, 2]);
    near(worldFrame.after.placement.rotation, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    const featurePlacement = {
      translation: [3, -5, 2],
      rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    };
    const world = await compute(
      path,
      [0, 0, 0],
      { objectIds: ["part"], type: "plane_center", offset: 1, limit: 1 },
      "scene_get_features",
      { manifestPath, featuresPath, placement: featurePlacement },
    );
    assert.equal(world.space, "world");
    assert.equal(world.objects?.[0]?.total, 3);
    assert.equal(world.objects?.[0]?.nextOffset, 2);
    assert.equal(world.objects?.[0]?.features?.[0]?.featureId, "front");
    near(world.objects?.[0]?.features?.[0]?.origin ?? [], [-20, 5, 32]);
    near(world.objects?.[0]?.features?.[0]?.direction ?? [], [-1, 0, 0]);
    const candidates = await compute(
      path,
      [0, 0, 0],
      { type: "plane_center", worldAxis: "Z", maxWorldZ: 32.05, limit: 1 },
      "scene_find_features",
      { manifestPath, featuresPath, placement: featurePlacement },
    );
    assert.equal(candidates.total, 1);
    assert.equal(candidates.featureCacheComplete, false);
    assert.equal(candidates.displayComplete, true);
    assert.equal(candidates.features?.[0]?.objectId, "part");
    assert.equal(candidates.features?.[0]?.featureId, "up");
    near(candidates.features?.[0]?.origin ?? [], [-20, 5, 32]);
    near(candidates.features?.[0]?.direction ?? [], [0, 0, 1]);
    const page = await compute(
      path,
      [0, 0, 0],
      { type: "plane_center", worldAxis: "Z", limit: 1 },
      "scene_find_features",
      { manifestPath, featuresPath, placement: featurePlacement },
    );
    assert.equal(page.total, 2);
    assert.equal(page.nextOffset, 1);
    const next = await compute(
      path,
      [0, 0, 0],
      { type: "plane_center", worldAxis: "Z", limit: 1, offset: page.nextOffset },
      "scene_find_features",
      { manifestPath, featuresPath, placement: featurePlacement },
    );
    assert.equal(next.features?.[0]?.featureId, "high");
    assert.equal(next.nextOffset, undefined);
    const cylinders = await compute(
      path,
      [0, 0, 0],
      { type: "cylinder_axis", worldAxis: "Z" },
      "scene_find_features",
      { manifestPath, featuresPath, placement: featurePlacement },
    );
    assert.equal(cylinders.features?.[0]?.featureId, "hole");
    assert.ok(Math.abs((cylinders.features?.[0]?.radius ?? 0) - 0.05) < 1e-8);
    await assert.rejects(
      compute(path, [0, 0, 0], { minAbsCos: 0.9 }, "scene_find_features", {
        manifestPath,
        featuresPath,
      }),
      /INVALID_ARGUMENT/,
    );
    const scaled = await compute(path, [0, 0, 0], { objectIds: ["scaled"] }, "scene_get_features", {
      manifestPath,
      featuresPath,
      placement: featurePlacement,
    });
    near(scaled.objects?.[0]?.features?.[0]?.direction ?? [], [
      -1 / Math.sqrt(5),
      -2 / Math.sqrt(5),
      0,
    ]);
    const scaledAligned = await compute(
      path,
      [0, 0, 0],
      {
        sourceDirection: { kind: "cad_feature", objectId: "scaled", featureId: "oblique" },
        targetDirection: [0, 0, 1],
        pivot: { kind: "bounds_center" },
      },
      "alignment_align_direction",
      { manifestPath, featuresPath, placement: featurePlacement },
    );
    near(scaledAligned.resolvedDirection?.source ?? [], [-1 / Math.sqrt(5), -2 / Math.sqrt(5), 0]);
    const grounded = await compute(
      path,
      [0, 0, 0],
      {
        groundZ: 0,
        contacts: [
          { objectId: "part", featureId: "up" },
          { objectId: "part", featureId: "high" },
        ],
      },
      "alignment_ground",
      { manifestPath, featuresPath, placement: featurePlacement },
    );
    near(grounded.after.placement.translation, [3, -5, -30]);
    near(grounded.after.placement.rotation, featurePlacement.rotation);
    near(grounded.groundContacts?.map((item) => item.afterZ) ?? [], [0, 0.1]);
    await assert.rejects(
      compute(
        path,
        [0, 0, 0],
        {
          groundZ: 0,
          contacts: [{ objectId: "part", featureId: "front" }],
        },
        "alignment_ground",
        { manifestPath, featuresPath, placement: featurePlacement },
      ),
      /GROUND_NOT_HORIZONTAL/,
    );
    await assert.rejects(
      compute(
        path,
        [0, 0, 0],
        { groundZ: 0, contacts: [{ objectId: "part", featureId: "up" }] },
        "alignment_ground",
        {
          manifestPath,
          featuresPath,
          placement: { translation: [0, 0, 0], rotation: [Math.sin(0.01), 0, 0, Math.cos(0.01)] },
        },
      ),
      /GROUND_NOT_HORIZONTAL/,
    );
    await assert.rejects(
      compute(path, [0, 0, 0], reference, "alignment_align_frame", { manifestPath }),
      /FEATURE_CACHE_MISSING/,
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        coordinateSystem: { unit: "m", upAxis: "Z", handedness: "right", gltfConversion: "x,z,-y" },
        complete: true,
        warnings: [],
        features: { objects: [] },
        objects: ["part", "other"].map((objectId) => ({ objectId, name: objectId, kind: "shape" })),
      }),
    );
    const lowest = await compute(path, [3, -5, 2], { order: "lowest", limit: 2 }, "scene_inspect", {
      manifestPath,
    });
    assert.equal(lowest.objects?.length, 2);
    for (const item of lowest.objects ?? []) {
      const exactBounds = await compute(
        path,
        [3, -5, 2],
        { objectId: item.objectId },
        "alignment_get_bounds",
      );
      near(item.bounds?.min ?? [], exactBounds.before.bounds.min);
      near(item.bounds?.max ?? [], exactBounds.before.bounds.max);
    }
    assert.ok(
      (lowest.objects?.[0]?.bounds?.min[2] ?? 0) <= (lowest.objects?.[1]?.bounds?.min[2] ?? 0),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
