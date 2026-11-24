import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { validateFileToolPath } from "../../../src/backend/agent/file_access.ts";

test("Pi 文件工具只允许访问项目目录和读取技能目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-file-access-"));
  const cwd = join(root, "project");
  const skill = join(root, "skill");
  const outside = join(root, "outside");
  await Promise.all([mkdir(cwd), mkdir(skill), mkdir(outside)]);
  await writeFile(join(cwd, "ok.txt"), "ok");
  await writeFile(join(skill, "SKILL.md"), "skill");
  await writeFile(join(outside, "secret.txt"), "secret");
  const base = { cwd, skillRoots: [skill] };
  try {
    await validateFileToolPath({ ...base, path: "@ok.txt", write: false });
    const literal = "@车间　一号";
    await Promise.all([mkdir(join(cwd, literal)), mkdir(join(cwd, "车间 一号"))]);
    assert.equal(
      await validateFileToolPath({ cwd, path: literal, write: false, literal: true }),
      await realpath(join(cwd, literal)),
    );
    await validateFileToolPath({ ...base, path: "new/sub/file.txt", write: true });
    await validateFileToolPath({ ...base, path: join(skill, "SKILL.md"), write: false });
    await validateFileToolPath({
      ...base,
      path: pathToFileURL(join(skill, "SKILL.md")).href,
      write: false,
    });
    await assert.rejects(
      validateFileToolPath({ ...base, path: "../outside/secret.txt", write: false }),
      /授权/,
    );
    await assert.rejects(
      validateFileToolPath({ ...base, path: join(skill, "SKILL.md"), write: true }),
      /授权/,
    );
    await assert.rejects(
      validateFileToolPath({ ...base, path: join(outside, "new.txt"), write: true }),
      /授权/,
    );
    if (process.platform !== "win32") {
      await symlink(outside, join(cwd, "escape"), "dir");
      await symlink(join(outside, "new-target"), join(cwd, "dangling"));
      await assert.rejects(
        validateFileToolPath({ ...base, path: "escape/secret.txt", write: false }),
        /授权/,
      );
      await assert.rejects(
        validateFileToolPath({ cwd, path: "escape/secret.txt", write: false, literal: true }),
        /授权/,
      );
      await assert.rejects(
        validateFileToolPath({ ...base, path: "escape/new.txt", write: true }),
        /授权/,
      );
      await assert.rejects(validateFileToolPath({ ...base, path: "dangling", write: true }));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
