import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canComparePlacement,
  captureTransition,
  labelPlacementComparison,
} from "../../../src/renderer/features/scene/logic/placementComparison.ts";

test("only committed revisions of the same loaded model can be compared", () => {
  const model = {};
  const previous = { importId: "a", revision: 1, model };
  assert.equal(canComparePlacement(previous, { ...previous, revision: 2 }, true), true);
  assert.equal(canComparePlacement(previous, { ...previous, revision: 2 }, false), false);
  assert.equal(canComparePlacement(previous, { ...previous, revision: 1 }, true), false);
  assert.equal(canComparePlacement(previous, { ...previous, revision: 0 }, true), false);
  assert.equal(
    canComparePlacement(previous, { ...previous, importId: "b", revision: 2 }, true),
    false,
  );
  assert.equal(canComparePlacement(previous, { ...previous, model: {}, revision: 2 }, true), false);
  assert.equal(canComparePlacement(previous, null, true), false);
});

test("both captures use one camera, surround the update and never block it on capture failure", () => {
  const frozenCamera = {};
  const events: string[] = [];
  const images = captureTransition(
    frozenCamera,
    (camera) => {
      assert.equal(camera, frozenCamera);
      events.push("capture");
      return events.length === 1 ? "old" : "new";
    },
    () => events.push("update"),
  );
  assert.deepEqual(events, ["capture", "update", "capture"]);
  assert.deepEqual(images, { before: "old", after: "new" });
  assert.ok(images);
  assert.deepEqual(
    labelPlacementComparison(
      { importId: "a", revision: 2, model: {} },
      { importId: "a", revision: 3, model: {} },
      images,
    ),
    { importId: "a", beforeRevision: 2, afterRevision: 3, before: "old", after: "new" },
  );
  let applied = false;
  assert.equal(
    captureTransition(
      frozenCamera,
      () => {
        throw new Error("lost context");
      },
      () => {
        applied = true;
      },
    ),
    null,
  );
  assert.equal(applied, true);
  assert.equal(
    captureTransition(
      frozenCamera,
      () => null,
      () => {},
    ),
    null,
  );
});
