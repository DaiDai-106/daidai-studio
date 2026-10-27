import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveSceneReference } from "../../../src/backend/agent/sceneReference.ts";
import type { SceneContext } from "../../../src/backend/agent/types.ts";

test("scene object references must belong to the current display and placement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dai-scene-reference-"));
  try {
    const path = join(directory, "objects.jsonl");
    await writeFile(path, '{"objectId":"part-1","name":"地脚"}\n');
    const reference = { importId: "a".repeat(64), objectId: "part-1", revision: 12 };
    const scene = {
      currentDisplay: { importId: reference.importId, placement: { revision: 12 } },
      files: { objects: [{ path }], catalogError: null },
    } as unknown as SceneContext;
    assert.deepEqual(await resolveSceneReference(reference, scene), { ...reference, name: "地脚" });
    await assert.rejects(
      resolveSceneReference({ ...reference, revision: 11 }, scene),
      /版本已变化/,
    );
    await assert.rejects(
      resolveSceneReference({ ...reference, importId: "b".repeat(64) }, scene),
      /版本已变化/,
    );
    await assert.rejects(
      resolveSceneReference({ ...reference, objectId: "missing" }, scene),
      /不属于当前场景/,
    );
    await assert.rejects(
      resolveSceneReference(reference, { ...scene, files: null }),
      /对象目录不可用/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
