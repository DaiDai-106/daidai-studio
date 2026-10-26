import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cadInputs, validateCadInput } from "../../resources/mcp/cad/contract.ts";
import { authorizeStepPath } from "../../src/backend/projects/files.ts";
import { fileHash } from "../../src/backend/projects/source.ts";

test("all callers use the same public CAD contract with explicit paths and handles", () => {
  assert.equal(Object.keys(cadInputs).length, 12);
  assert.deepEqual(cadInputs.cad_import_step.required, ["path"]);
  validateCadInput("cad_import_step", { path: "/model.step" });
  for (const input of [
    {},
    { path: "/model.step", sourceId: "other" },
    { path: "/model.step", operationKey: "hidden" },
  ])
    assert.throws(() => validateCadInput("cad_import_step", input));
  assert.deepEqual(cadInputs.cad_build_display.required, ["document", "quality"]);
});

test("desktop authorizes the frozen selected STEP without changing tool parameters", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-path-"));
  const path = join(root, "模型.step");
  await writeFile(path, "source");
  const source = { path, relativePath: "模型.step", sha256: (await fileHash(path, 1000)).sha256 };
  const signal = AbortSignal.timeout(5000);
  try {
    for (const value of [undefined, "模型.step", join(root, "other.step")])
      await assert.rejects(authorizeStepPath(root, source, value, signal));
    await authorizeStepPath(root, source, path, signal);
    await writeFile(path, "changed");
    await assert.rejects(authorizeStepPath(root, source, path, signal), /发生变化/);
    if (process.platform !== "win32") {
      await rm(path);
      await mkdir(join(root, "sub"));
      await writeFile(join(root, "sub", "other.step"), "source");
      await symlink(join(root, "sub", "other.step"), path);
      await assert.rejects(authorizeStepPath(root, source, path, signal), /符号链接/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
