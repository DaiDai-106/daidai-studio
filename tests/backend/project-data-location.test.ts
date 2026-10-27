import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectDataDirectory } from "../../src/backend/artifacts/location.ts";

test("project data directories use the isolated data root and reject unsafe identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-data-"));
  try {
    const data = join(root, "数据 目录");
    await mkdir(data);
    assert.equal(
      await projectDataDirectory(data, "project-a"),
      join(await realpath(data), "projects", "project-a"),
    );
    assert.notEqual(
      await projectDataDirectory(data, "project-a"),
      await projectDataDirectory(data, "project-b"),
    );
    await assert.rejects(projectDataDirectory(data, "../project-b"), /项目身份无效/);
    await assert.rejects(projectDataDirectory(data, "a/b"), /项目身份无效/);
    if (process.platform !== "win32") {
      await symlink(root, join(data, "projects", "linked"));
      await assert.rejects(projectDataDirectory(data, "linked"), /项目数据目录不可用/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
