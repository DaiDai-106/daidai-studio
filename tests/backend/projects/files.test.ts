import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSteps, resolveStepPath } from "../../../resources/mcp/scene-profiles/steps.ts";
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
    assert.equal(initial.filesComplete, true);
    assert.equal(initial.files.length, 3);
    // Windows ACLs and root privileges do not follow these POSIX mode bits.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await chmod(locked, 0);
      await assert.rejects(readdir(locked), { code: "EACCES" });
      const partial = await projectFiles(project);
      validateResult("project.refresh", partial);
      assert.equal(partial.available, true);
      assert.equal(partial.filesComplete, false);
      assert.deepEqual(partial.files, ["assembly.STEP", "models/part.stp"]);
      await chmod(path, 0);
      const unavailable = await projectFiles(project);
      assert.equal(unavailable.available, false);
      assert.equal(unavailable.filesComplete, false);
      assert.deepEqual(unavailable.files, []);
    }
    const missing = await projectFiles({ ...project, path: join(root, "missing") });
    assert.equal(missing.available, false);
    assert.equal(missing.filesComplete, false);
    assert.deepEqual(missing.files, []);
  } finally {
    await chmod(path, 0o700);
    await chmod(locked, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit STEP paths can resolve beyond a truncated list without escaping the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-project-step-path-"));
  const project = join(root, "project");
  const relativePath = "deep/a/b/c/d/e/truncated.step";
  try {
    await mkdir(join(project, "deep", "a", "b", "c", "d", "e"), { recursive: true });
    await writeFile(join(project, relativePath), "scan fixture");
    const listed = await listSteps(project);
    assert.equal(listed.complete, false);
    assert.ok(!listed.files.includes(relativePath));
    assert.deepEqual(await resolveStepPath(project, relativePath), {
      path: join(project, relativePath),
      relativePath,
    });
    await assert.rejects(resolveStepPath(project, join(root, "outside.step")), /项目内/);
    await assert.rejects(resolveStepPath(project, "../outside.step"), /项目内/);
    await assert.rejects(resolveStepPath(project, "deep\\outside.step"), /项目内/);
    await assert.rejects(resolveStepPath(project, "deep/a/b/c/d/e/truncated.txt"), /项目内/);
    if (process.platform !== "win32") {
      await symlink(join(project, relativePath), join(project, "linked.step"));
      await assert.rejects(resolveStepPath(project, "linked.step"), /符号链接/);
      await mkdir(join(root, "outside"));
      await writeFile(join(root, "outside", "outside.step"), "outside fixture");
      await symlink(join(root, "outside"), join(project, "linked"));
      await assert.rejects(resolveStepPath(project, "linked/outside.step"), /符号链接/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
