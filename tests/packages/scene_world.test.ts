import assert from "node:assert/strict";
import { test } from "node:test";
import { getWorldBounds, type SceneObject } from "../../packages/scene/src/world.ts";

function object(overrides: Partial<SceneObject> = {}): SceneObject {
  return {
    id: "part",
    parentId: null,
    rigidTransform: true,
    baseTransform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    geometryBounds: { min: [0, 0, 0], max: [1, 2, 3], unit: "m", space: "object-local" },
    ...overrides,
  };
}

test("旧数据、缩放、缺失父对象和循环层级不能产生误导的世界边界", () => {
  const { rigidTransform: _rigid, geometryBounds: _bounds, ...legacy } = object();
  assert.throws(() => getWorldBounds([legacy], "part"), /局部几何边界/);
  assert.ok(_bounds);
  assert.throws(() => getWorldBounds([{ ...legacy, geometryBounds: _bounds }], "part"), /刚体/);
  assert.throws(() => getWorldBounds([object({ rigidTransform: false })], "part"), /缩放/);
  assert.throws(() => getWorldBounds([object({ parentId: "missing" })], "part"), /父对象不存在/);
  assert.throws(() => getWorldBounds([object({ parentId: "part" })], "part"), /循环/);
  assert.throws(() => getWorldBounds([object(), object()], "part"), /重复/);
  assert.throws(
    () =>
      getWorldBounds(
        [object({ baseTransform: { position: [0, 0, NaN], rotation: [0, 0, 0, 1] } })],
        "part",
      ),
    /无效/,
  );
});
