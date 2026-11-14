import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSkillService } from "../../../src/backend/extensions/skill_service.ts";

const skillText =
  "---\nname: sample\ndescription: Example skill\ncustom: retained\n---\nUse references/guide.md.\n";

test("standard skill import retains complete directory and editing preserves unrelated assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-skill-test-"));
  try {
    const source = join(root, "sample");
    await mkdir(join(source, "references"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), skillText);
    await writeFile(join(source, "references", "guide.md"), "A guide\n");
    const service = createSkillService({ dataRoot: join(root, "data") });
    const imported = await service.importDirectory(source);
    assert.equal(imported.name, "sample");
    assert.equal((await service.list()).skills[0]?.name, "sample");
    assert.equal(await service.read("sample"), skillText);
    assert.equal(
      await readFile(join(imported.baseDir, "references", "guide.md"), "utf8"),
      "A guide\n",
    );
    const edited = skillText.replace("Use references", "Read references");
    await service.save("sample", edited);
    assert.equal(await service.read("sample"), edited);
    assert.equal(await readFile(join(source, "SKILL.md"), "utf8"), skillText);
    assert.equal(
      await readFile(join(imported.baseDir, "references", "guide.md"), "utf8"),
      "A guide\n",
    );
    await assert.rejects(service.importDirectory(source), /已存在/);
    await assert.rejects(service.create("sample", skillText), /已存在/);
    assert.equal(await service.read("sample"), edited, "失败的重复创建不能回收已有技能");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill names, content, and imported symlinks are checked before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-skill-test-"));
  try {
    const service = createSkillService({ dataRoot: join(root, "data") });
    await assert.rejects(service.create("../outside", skillText), /名称/);
    await assert.rejects(service.create("invalid", "not a skill"));
    const source = join(root, "sample");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), skillText);
    await symlink(join(root, "outside"), join(source, "link"));
    await assert.rejects(service.importDirectory(source), /符号链接/);
    await assert.rejects(service.importDirectory(root), /不能包含 Dai/);
    assert.deepEqual((await service.list()).skills, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
