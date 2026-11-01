import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Box3, Group, type Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { markDeletedSubtree } from "../../packages/scene/src/objects.ts";
import { createSceneRuntime, type SceneImportResult } from "../../packages/scene/src/runtime.ts";
import {
  alignBoundsToOrigin,
  getObjectWorldTransform,
  getWorldBounds,
} from "../../packages/scene/src/world.ts";
import { applySceneVisibility } from "../../src/renderer/features/scene/logic/visibility.ts";

const python = process.env.DAI_SCENE_TEST_PYTHON;
const near = (
  actual: readonly [number, number, number],
  expected: readonly [number, number, number],
) => {
  for (const i of [0, 1, 2] as const)
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `${actual} vs ${expected}`);
};

test("真实 STEP 的多层旋转和不同实例使用世界边界，对齐保持局部旋转", {
  timeout: 30_000,
  skip: python ? false : "需要配置 DAI_SCENE_TEST_PYTHON",
}, async () => {
  assert.ok(python);
  const directory = await mkdtemp(join(tmpdir(), "dai-real-world-"));
  const source = join(directory, "assembly.step");
  const runtime = createSceneRuntime({
    projectId: "world",
    cwd: directory,
    dataDir: join(directory, "data"),
    pythonExecutable: python,
  });
  try {
    await promisify(execFile)(python, [
      "-c",
      "import sys; sys.path.insert(0,sys.argv[1]); from assembly_fixture import write_assembly; write_assembly(sys.argv[2], True, True)",
      resolve("tests/python"),
      source,
    ]);
    const result = (await runtime.call("scene_import", { path: source })) as SceneImportResult;
    const objects = result.objects;
    const firstParent = objects.find((item) => item.name === "SubInstance");
    const first = objects.find(
      (item) => item.name === "FirstBlock" && item.parentId === firstParent?.id,
    );
    const second = objects.find(
      (item) => item.name === "SecondBlock" && item.parentId === firstParent?.id,
    );
    assert.ok(first && second);
    const firstWorld = getObjectWorldTransform(objects, first.id);
    near(firstWorld.position, [-0.04, 0, 0.08]);
    const secondWorld = getObjectWorldTransform(objects, second.id);
    near(secondWorld.position, [0, 0.06, 0.08]);
    const firstBounds = getWorldBounds(objects, first.id);
    assert.equal(firstBounds.unit, "m");
    assert.equal(firstBounds.space, "world-z-up");
    assert.equal(firstBounds.accuracy, "conservative");
    near(firstBounds.min, [-0.06, 0, 0.08]);
    near(firstBounds.max, [-0.04, 0.01, 0.11]);
    const secondBounds = getWorldBounds(objects, second.id);
    near(secondBounds.min, [-0.01, 0.04, 0.08]);
    near(secondBounds.max, [0, 0.06, 0.11]);
    // 与前端同样通过 GLTFLoader 加载，并以 Z-up 包装验证真实渲染矩阵。
    const bytes = await readFile(result.resource.path);
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const wrapper = new Group();
    wrapper.rotation.x = Math.PI / 2;
    wrapper.add(gltf.scene);
    wrapper.updateMatrixWorld(true);
    let rendered: Object3D | undefined;
    gltf.scene.traverse((node) => {
      if (node.userData.daiObjectId === second.id) rendered = node;
    });
    assert.ok(rendered);
    assert.equal(gltf.parser.associations.get(rendered)?.nodes, second.gltfNode);
    const visualBounds = new Box3().setFromObject(rendered, true);
    near([visualBounds.min.x, visualBounds.min.y, visualBounds.min.z], secondBounds.min);
    near([visualBounds.max.x, visualBounds.max.y, visualBounds.max.z], secondBounds.max);
    const aligned = alignBoundsToOrigin(objects, first.id);
    assert.deepEqual(aligned.rotation, first.baseTransform.rotation);
    const moved = objects.map((item) =>
      item.id === first.id ? { ...item, transform: aligned } : item,
    );
    near(getWorldBounds(moved, first.id).min, [0, 0, 0]);
    near(getWorldBounds(moved, second.id).min, secondBounds.min);
    const alignedRotated = alignBoundsToOrigin(objects, second.id);
    assert.deepEqual(alignedRotated.rotation, second.baseTransform.rotation);
    rendered.position.set(...alignedRotated.position);
    rendered.quaternion.set(...alignedRotated.rotation);
    wrapper.updateMatrixWorld(true);
    const visualAligned = new Box3().setFromObject(rendered, true);
    near([visualAligned.min.x, visualAligned.min.y, visualAligned.min.z], [0, 0, 0]);
    const rotatedMoved = objects.map((item) =>
      item.id === second.id ? { ...item, transform: alignedRotated } : item,
    );
    near(getWorldBounds(rotatedMoved, second.id).min, [0, 0, 0]);
    const scaled = objects.map((item) =>
      item.id === firstParent?.id ? { ...item, rigidTransform: false } : item,
    );
    assert.throws(() => getWorldBounds(scaled, first.id), /缩放|刚体/);
    assert.throws(() => alignBoundsToOrigin(scaled, first.id), /缩放|刚体/);
    assert.ok(firstParent);
    const sibling = objects.find(
      (item) => item.name === "FirstBlock" && item.parentId !== firstParent.id,
    );
    assert.ok(sibling);
    const originalStep = await readFile(source);
    const originalGlb = await readFile(result.resource.path);
    const afterDeletion = markDeletedSubtree(objects, firstParent.id);
    applySceneVisibility(gltf, afterDeletion);
    const visibility = new Map<string, boolean>();
    gltf.scene.traverse((node) => {
      const id = node.userData.daiObjectId;
      if (typeof id === "string") {
        let visible = true;
        for (let current: Object3D | null = node; current; current = current.parent)
          visible &&= current.visible;
        visibility.set(id, visible);
      }
    });
    assert.equal(visibility.get(firstParent.id), false);
    assert.equal(visibility.get(first.id), false);
    assert.equal(visibility.get(second.id), false);
    assert.equal(visibility.get(sibling.id), true);
    assert.deepEqual(await readFile(source), originalStep);
    assert.deepEqual(await readFile(result.resource.path), originalGlb);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
