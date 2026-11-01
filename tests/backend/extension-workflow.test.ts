import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";

test("Pi 包和标准技能在应用入口按项目隔离、只读并可启停", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-extension-workflow-"));
  const packageDir = join(root, "package");
  await mkdir(join(packageDir, "skills", "pkg-skill"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "dai-test-package" }));
  await writeFile(
    join(packageDir, "skills", "pkg-skill", "SKILL.md"),
    "---\nname: pkg-skill\ndescription: package test skill\n---\npackage content\n",
  );
  const app = await openApplication({
    dataRoot: join(root, "data"),
    sceneSkillPath: resolve("packages/scene/skills/scene"),

    publish: () => {},
  });
  try {
    const a = await app.request("project.create", { name: "A", mode: "scene", path: root });
    const b = await app.request("project.create", { name: "B", mode: "scene", path: root });
    const skill = await app.request("skill.library.create", {
      name: "my-skill",
      text: "---\nname: my-skill\ndescription: my test skill\n---\nuser content\n",
    });
    assert.equal(skill.source, "user");
    assert.equal(skill.editable, true);
    assert.match(await app.request("skill.library.read", { id: skill.id }), /user content/);
    await app.request("package.install", { source: packageDir, scope: "project", projectId: a.id });
    const packageInfo = await app.request("package.list", { projectId: a.id });
    assert.equal(packageInfo.length, 1);
    await app.request("package.update", { source: packageDir, projectId: a.id });
    assert.equal((await app.request("package.list", { projectId: a.id })).length, 1);
    const skillsA = await app.request("skill.library.list", { projectId: a.id });
    const packageSkill = skillsA.find((item) => item.name === "pkg-skill");
    assert.equal(packageSkill?.source, "package");
    assert.equal(packageSkill.editable, false);
    assert.match(
      await app.request("skill.library.read", { id: packageSkill.id, projectId: a.id }),
      /package content/,
    );
    assert.ok(skillsA.some((item) => item.source === "builtin" && !item.editable));
    const skillsB = await app.request("skill.library.list", { projectId: b.id });
    assert.ok(!skillsB.some((item) => item.name === "pkg-skill"));
    assert.ok(skillsB.some((item) => item.name === "my-skill"));
    await app.request("package.setEnabled", {
      source: packageDir,
      scope: "project",
      projectId: a.id,
      enabled: false,
    });
    assert.ok(
      !(await app.request("skill.library.list", { projectId: a.id })).some(
        (item) => item.name === "pkg-skill",
      ),
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
