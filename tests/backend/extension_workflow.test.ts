import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";
import { runPackageAction } from "../support/catalog_task.ts";
import { createThemePackage } from "../support/desktop_theme.ts";

test("Pi 包和技能按模块共享，无需项目即可浏览、读取和启停", async () => {
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

    publish: () => {},
  });
  try {
    const skill = await app.request("skill.library.create", {
      name: "my-skill",
      text: "---\nname: my-skill\ndescription: my test skill\n---\nuser content\n",
    });
    assert.equal(skill.source, "user");
    assert.equal(skill.editable, true);
    assert.match(await app.request("skill.library.read", { id: skill.id }), /user content/);
    await runPackageAction(app, {
      action: "install",
      source: packageDir,
      scope: "module",
      moduleId: "coding",
    });
    const packageInfo = await app.request("catalog.installed", { moduleId: "coding" });
    assert.equal(packageInfo.length, 1);
    await runPackageAction(app, {
      action: "update",
      scope: "module",
      source: packageDir,
      moduleId: "coding",
    });
    assert.equal((await app.request("catalog.installed", { moduleId: "coding" })).length, 1);
    const codingSkills = await app.request("skill.library.list", { moduleId: "coding" });
    const packageSkill = codingSkills.find((item) => item.name === "pkg-skill");
    assert.equal(packageSkill?.source, "package");
    assert.equal(packageSkill?.ownerSource, packageDir);
    assert.equal(packageSkill?.ownerScope, "module");
    assert.equal(packageSkill.editable, false);
    assert.match(
      await app.request("skill.library.read", { id: packageSkill.id, moduleId: "coding" }),
      /package content/,
    );
    const defaultSkills = await app.request("skill.library.list", {});
    assert.ok(
      defaultSkills.some((item) => item.name === "pkg-skill"),
      "未指定模块时默认使用 Coding 模块",
    );
    assert.ok(defaultSkills.some((item) => item.name === "my-skill"));
    const scene = await app.request("skill.library.list", { moduleId: "scene" });
    assert.ok(!scene.some((item) => item.name === "pkg-skill"));
    assert.ok(
      scene.some((item) => item.name === "my-skill"),
      "个人技能全局共享",
    );
    await assert.rejects(
      app.request("skill.library.read", { id: packageSkill.id, moduleId: "scene" }),
      /不存在或未启用/,
    );
    await runPackageAction(app, { action: "install", source: packageDir, scope: "global" });
    assert.equal(
      (await app.request("skill.library.list", { moduleId: "coding" })).find(
        (item) => item.name === "pkg-skill",
      )?.ownerScope,
      "module",
    );
    assert.equal(
      (await app.request("skill.library.list", { moduleId: "scene" })).find(
        (item) => item.name === "pkg-skill",
      )?.ownerScope,
      "global",
    );
    assert.ok(
      (await app.request("skill.library.list", { moduleId: "scene" })).some(
        (item) => item.name === "pkg-skill",
      ),
    );
    await runPackageAction(app, {
      action: "disable",
      source: packageDir,
      scope: "module",
      moduleId: "coding",
    });
    assert.ok(
      !(await app.request("skill.library.list", { moduleId: "coding" })).some(
        (item) => item.name === "pkg-skill",
      ),
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi 回复进行中仍可操作纯 Desktop 主题，Agent 插件操作继续受会话锁约束", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-desktop-live-agent-"));
  const originalFetch = globalThis.fetch;
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const app = await openApplication({ dataRoot: join(root, "data"), publish() {} });
  try {
    const theme = join(root, "theme");
    const agent = join(root, "agent");
    await createThemePackage(theme);
    await mkdir(agent);
    await writeFile(
      join(agent, "package.json"),
      JSON.stringify({ name: "agent", pi: { extensions: ["index.ts"] } }),
    );
    await writeFile(join(agent, "index.ts"), "export default () => {};");
    await runPackageAction(app, { source: agent, scope: "global", action: "install" });
    await app.request("provider.save", {
      config: {
        id: "local",
        name: "Local",
        providerType: "local",
        authMethod: "none",
        endpoint: "http://127.0.0.1:11434/v1",
        enabled: true,
        models: [
          { id: "example", name: "Example", context: 4096, output: 1024, reasoning: "标准" },
        ],
      },
    });
    const project = await app.request("project.create", {
      name: "项目",
      mode: "coding",
      path: root,
    });
    const conversation = await app.request("conversation.create", { projectId: project.id });
    globalThis.fetch = async () => {
      started.resolve();
      return response.promise;
    };
    await app.request("conversation.send", {
      id: conversation.id,
      requestId: "busy",
      text: "继续回复",
    });
    await started.promise;
    const before = await app.request("conversation.watch", { id: conversation.id });
    assert.equal(before.busy, true);
    for (const action of ["install", "update", "disable", "enable", "remove"] as const)
      await runPackageAction(app, { source: theme, host: "desktop", scope: "global", action });
    const after = await app.request("conversation.watch", { id: conversation.id });
    assert.equal(after.busy, true);
    assert.equal(after.streamId, before.streamId);
    await assert.rejects(
      runPackageAction(app, { source: agent, scope: "global", action: "disable" }),
      /先停止相关会话/,
    );
    assert.equal(
      (await app.request("catalog.installed", {})).find((p) => p.source === agent)?.enabled,
      true,
    );
  } finally {
    response.resolve(
      new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
    );
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi 包配置损坏时仍可列出和读取个人技能", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-user-skill-isolation-"));
  const app = await openApplication({ dataRoot: root, publish() {} });
  try {
    const own = await app.request("skill.library.create", {
      name: "personal",
      text: "---\nname: personal\ndescription: own instructions\n---\nPersonal content.\n",
    });
    await mkdir(join(root, "agent/packages"), { recursive: true });
    await writeFile(join(root, "agent/packages/settings.json"), "{");
    assert.deepEqual(await app.request("skill.library.list", { userOnly: true }), [own]);
    assert.match(await app.request("skill.library.read", { id: own.id }), /Personal content/);
    await assert.rejects(app.request("skill.library.list", {}));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
