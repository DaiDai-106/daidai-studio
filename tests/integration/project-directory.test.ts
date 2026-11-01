import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  createProjectDirectory,
  projectDirectoryName,
} from "../../src/desktop/main/projectDirectory.ts";

test("default project folders are safe and do not overwrite existing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-project-folder-"));
  try {
    const first = await createProjectDirectory(root, "产线/A");
    await writeFile(join(first, "keep.txt"), "existing");
    const second = await createProjectDirectory(root, "产线/A");
    assert.equal(basename(first), "产线-A");
    assert.equal(basename(second), "产线-A-2");
    assert.equal(await readFile(join(first, "keep.txt"), "utf8"), "existing");
    assert.equal(projectDirectoryName("../.."), "..-");
    assert.equal(projectDirectoryName("CON"), "_CON");
    const longName = "🤖".repeat(200);
    const longDirectory = await createProjectDirectory(root, longName);
    assert.equal(basename(longDirectory), "🤖".repeat(50));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
