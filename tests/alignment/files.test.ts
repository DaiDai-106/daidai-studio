import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decodePlacementChange } from "../../resources/mcp/alignment/contract.ts";
import { readPlacement, writePlacement } from "../../resources/mcp/alignment/files.ts";

test("placement files are atomic, bounded and confined; no file means the original position", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-placement-files-"));
  const importId = "a".repeat(64),
    sourceHash = "b".repeat(64);
  try {
    const original = await readPlacement(root, importId, sourceHash);
    assert.deepEqual(original.translation, [0, 0, 0]);
    assert.equal(original.revision, 0);
    const value = {
      ...original,
      revision: 15,
      translation: [1, -2, 3] as [number, number, number],
    };
    await writePlacement(root, value);
    assert.deepEqual(await readPlacement(root, importId, sourceHash), value);
    assert.deepEqual(await readdir(join(root, "placements")), [`${importId}.json`]);
    await assert.rejects(readPlacement(root, "../escape", sourceHash), /Invalid/);
    await assert.rejects(readPlacement(root, importId, "c".repeat(64)), /Invalid/);
    await assert.rejects(writePlacement(root, { ...value, translation: [NaN, 0, 0] }), /Invalid/);
    assert.deepEqual(await readPlacement(root, importId, sourceHash), value);
    const legacy = { schemaVersion: 1, importId, sourceHash, revision: 7, translation: [1, 2, 3] };
    await writeFile(join(root, "placements", `${importId}.json`), JSON.stringify(legacy));
    assert.deepEqual((await readPlacement(root, importId, sourceHash)).rotation, [0, 0, 0, 1]);
    const oldResult = { importId, sourceHash, expectedRevision: 0, translation: [1, 2, 3] };
    assert.deepEqual(decodePlacementChange(oldResult)?.rotation, [0, 0, 0, 1]);
    assert.equal(
      decodePlacementChange({ ...oldResult, schemaVersion: 2 }),
      undefined,
      "v2 must not hide missing rotation",
    );
    await assert.rejects(writePlacement(root, { ...value, rotation: [0, 0, 0, 2] }), /Invalid/);
    if (process.platform !== "win32") {
      const outside = join(root, "outside.json");
      await writeFile(outside, "untouched");
      await rm(join(root, "placements", `${importId}.json`));
      await symlink(outside, join(root, "placements", `${importId}.json`));
      await assert.rejects(readPlacement(root, importId, sourceHash), /Linked/);
      await assert.rejects(writePlacement(root, value), /Invalid/);
      assert.equal(await readFile(outside, "utf8"), "untouched");
      await rm(join(root, "placements"), { recursive: true });
      await mkdir(join(root, "other"));
      await symlink(join(root, "other"), join(root, "placements"));
      await assert.rejects(writePlacement(root, value), /Invalid/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
