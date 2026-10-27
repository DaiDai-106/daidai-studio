import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadSceneReferences,
  saveSceneReferences,
  verifySceneReference,
} from "../../src/renderer/workbench/sceneReferenceDrafts.ts";

test("object references survive restart but require revalidation", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const reference = { importId: "a".repeat(64), objectId: "foot", revision: 7, name: "地脚" };
  saveSceneReferences(storage, { "23": reference, "24": { ...reference, stale: true } });
  assert.deepEqual(loadSceneReferences(storage), {
    "23": { ...reference, checking: true },
    "24": { ...reference, stale: true },
  });
  const restored = loadSceneReferences(storage);
  assert.deepEqual(verifySceneReference(restored, "23", reference.importId, 7)["23"], {
    ...reference,
    stale: false,
    checking: false,
  });
  assert.deepEqual(verifySceneReference(restored, "23", reference.importId, 8)["23"], {
    ...reference,
    stale: true,
    checking: false,
  });
  assert.deepEqual(verifySceneReference(restored, "23", "b".repeat(64), 7)["23"], {
    ...reference,
    stale: true,
    checking: false,
  });
  assert.equal(verifySceneReference(restored, "24", reference.importId, 7)["24"]?.stale, true);
  saveSceneReferences(storage, {});
  assert.deepEqual(loadSceneReferences(storage), {});
});
