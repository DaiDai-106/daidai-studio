import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectFiles } from "../../../src/backend/projects/files.ts";
import { validateResult } from "../../../src/shared/application.ts";

test("project scanning retains accessible STEP files when a child directory is unreadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-project-scan-"));
  const path = join(root, "项目");
  const locked = join(path, "restricted");
  await mkdir(locked, { recursive: true });
  await mkdir(join(path, "models"));
  await writeFile(join(path, "assembly.STEP"), "scan fixture");
  await writeFile(join(path, "models", "part.stp"), "scan fixture");
  await writeFile(join(locked, "private.step"), "scan fixture");
  const project = { id: "project", name: "项目", path };
  try {
    const initial = await projectFiles(project);
    assert.equal(initial.available, true);
    assert.equal(initial.files.length, 3);
    // Windows ACLs and root privileges do not follow these POSIX mode bits.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await chmod(locked, 0);
      await assert.rejects(readdir(locked), { code: "EACCES" });
      const partial = await projectFiles(project);
      validateResult("project.refresh", partial);
      assert.equal(partial.available, true);
      assert.deepEqual(partial.files, ["assembly.STEP", "models/part.stp"]);
      await chmod(path, 0);
      const unavailable = await projectFiles(project);
      assert.equal(unavailable.available, false);
      assert.deepEqual(unavailable.files, []);
    }
    const missing = await projectFiles({ ...project, path: join(root, "missing") });
    assert.equal(missing.available, false);
    assert.deepEqual(missing.files, []);
  } finally {
    await chmod(path, 0o700);
    await chmod(locked, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
