import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";
import { createPackageService } from "../../src/backend/extensions/package_service.ts";
import { validateResult } from "../../src/contracts/application.ts";
import { readDesktopThemes } from "../../src/desktop/main/themes.ts";
import { createThemePackage, desktopThemeId } from "../support/desktop_theme.ts";

test("主题拒绝路径越界、缺失资源、未知变量和 CSS 注入，不影响其他主题", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-theme-validation-"));
  const source = join(root, "theme");
  const dataRoot = join(root, "data");
  await createThemePackage(source);
  const app = await openApplication({ dataRoot, publish: () => {} });
  const packages = createPackageService({ dataRoot, host: "desktop" });
  await packages.install(source, "global");
  const path = join(source, "palettes/light.json");
  const original = await readFile(path, "utf8");
  try {
    for (const [name, value] of [
      ["--surface", "url(https://example.com/leak)"],
      ["--surface", "#ffffff00"],
      ["--theme-backdrop", "#ffffff"],
      ["--shadow", "var(--text)"],
      ["--shadow", undefined],
      ["--unknown", "#ffffff"],
    ] as const) {
      const palette = JSON.parse(original);
      if (value === undefined) delete palette.variables[name];
      else palette.variables[name] = value;
      await writeFile(path, JSON.stringify(palette));
      const result = await readDesktopThemes(
        await app.request("package.list", { host: "desktop" }),
      );
      assert.equal(result.themes.length, 0);
      assert.match(result.errors[`global:${source}`] ?? "", /配色/);
    }
    await rm(path);
    assert.equal(
      Object.keys(
        (await readDesktopThemes(await app.request("package.list", { host: "desktop" }))).errors,
      ).length,
      1,
    );
    const outside = join(root, "outside.json");
    await writeFile(outside, original);
    await symlink(outside, path);
    assert.match(
      (await readDesktopThemes(await app.request("package.list", { host: "desktop" }))).errors[
        `global:${source}`
      ] ?? "",
      /包外/,
    );
    await rm(path);
    await writeFile(path, original);
    assert.equal(
      (await readDesktopThemes(await app.request("package.list", { host: "desktop" }))).themes
        .length,
      1,
    );
    assert.deepEqual(await createPackageService({ dataRoot }).resolve(), {
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("桌面插件在安装前拒绝模块作用域，不写入配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-module-theme-"));
  try {
    const source = join(root, "theme");
    const dataRoot = join(root, "data");
    await createThemePackage(source);
    const packages = createPackageService({ dataRoot, host: "desktop" });
    await assert.rejects(packages.install(source, "module"), /全局安装/);
    assert.deepEqual(await packages.inspect(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop 清单变更不能获得 Agent 入口，混合包拒绝重装", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-theme-host-"));
  const dataRoot = join(root, "data");
  const source = join(root, "plugin");
  await createThemePackage(source);
  const app = await openApplication({ dataRoot, publish: () => {} });
  const desktop = createPackageService({ dataRoot, host: "desktop" });
  try {
    await desktop.install(`~/${relative(homedir(), source)}`, "global");
    const path = join(source, "package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.dai.panels = [];
    await writeFile(path, JSON.stringify(manifest));
    const result = await readDesktopThemes(await app.request("package.list", { host: "desktop" }));
    assert.equal(result.themes.length, 1, "尚未开放的贡献点不影响已有主题");
    manifest.pi = { extensions: ["extension.ts"] };
    await writeFile(join(source, "extension.ts"), "throw new Error('must not run in Agent');");
    await writeFile(path, JSON.stringify(manifest));
    assert.deepEqual(await createPackageService({ dataRoot }).inspect(), []);
    assert.equal((await createPackageService({ dataRoot }).resolve()).extensions.length, 0);
    await assert.rejects(desktop.install(source, "global"), /混合/);
    await assert.rejects(createPackageService({ dataRoot }).install(source, "global"), /混合/);
    assert.match((await desktop.inspect())[0]?.manifestError ?? "", /混合/);
    assert.equal((await readDesktopThemes(await desktop.inspect())).themes.length, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop 归属跨服务实例持久化，清单丢失或损坏也不进入 Agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-theme-agent-isolation-"));
  const dataRoot = join(root, "data");
  const source = join(root, "theme");
  await createThemePackage(source);
  await writeFile(
    join(source, "index.ts"),
    "throw new Error('Desktop entry must not run in Agent');",
  );
  const app = await openApplication({ dataRoot, publish: () => {} });
  try {
    await createPackageService({ dataRoot, host: "desktop" }).install(source, "global");
    const settingsPath = join(dataRoot, "desktop/packages/settings.json");
    const before = await readFile(settingsPath, "utf8");
    assert.equal(
      (await createPackageService({ dataRoot, host: "desktop" }).inspect())[0]?.host,
      "desktop",
    );
    assert.equal(await readFile(settingsPath, "utf8"), before, "读取快照不应重写安装配置");
    assert.doesNotMatch(before, /daiHost|"extensions"/);
    const path = join(source, "package.json");
    const original = await readFile(path, "utf8");
    for (const content of [undefined, "{"]) {
      if (content === undefined) await rm(path);
      else await writeFile(path, content);
      let agentChanges = 0;
      const reopened = createPackageService({
        dataRoot,
        host: "desktop",
        async beforeAgentChange() {
          agentChanges++;
        },
      });
      const [item] = await reopened.inspect();
      assert.equal(item?.host, "desktop");
      assert.ok(item?.manifestError);
      // 无法读取清单时，重装/更新必须保留原宿主，不能把未知状态提交为 Agent。
      await assert.rejects(reopened.install(source, "global"));
      await assert.rejects(reopened.update(source, "global"));
      assert.equal(agentChanges, 0);
      assert.deepEqual(await createPackageService({ dataRoot }).resolve(), {
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      });
      const [installed] = await app.request("catalog.installed", {});
      assert.equal(installed?.loadState, "failed");
      assert.ok(installed?.error);
    }
    await writeFile(path, original);
    assert.equal(
      (await createPackageService({ dataRoot, host: "desktop" }).inspect())[0]?.manifestError,
      "",
    );
    // 仍允许 Pi 的无清单约定目录，不能用一律屏蔽 ENOENT 代替宿主区分。
    const legacy = join(root, "legacy");
    await mkdir(legacy);
    await writeFile(join(legacy, "index.ts"), "export default () => {};");
    await createPackageService({ dataRoot }).install(legacy, "global");
    assert.deepEqual(
      (await createPackageService({ dataRoot }).resolve()).extensions.map((r) => r.path),
      [legacy],
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("市场配置损坏不影响安装快照或 Desktop 主题发现", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-theme-catalog-isolation-"));
  const dataRoot = join(root, "data");
  const source = join(root, "theme");
  await createThemePackage(source);
  const app = await openApplication({ dataRoot, publish: () => {} });
  try {
    await createPackageService({ dataRoot, host: "desktop" }).install(source, "global");
    const before = await app.request("package.list", { host: "desktop" });
    validateResult("package.list", before);
    const catalog = join(dataRoot, "catalog");
    await mkdir(catalog, { recursive: true });
    for (const name of ["sources.json", "origins.json"]) {
      await writeFile(join(catalog, name), "{");
      if (name === "sources.json") {
        await assert.rejects(app.request("catalog.installed", {}), /目录配置损坏/);
      } else {
        const [installed] = await app.request("catalog.installed", {});
        assert.equal(installed?.source, source);
        assert.equal(installed?.sourceId, "manual");
      }
      const packages = await app.request("package.list", { host: "desktop" });
      assert.deepEqual(packages, before);
      assert.equal((await readDesktopThemes(packages, desktopThemeId)).selection, "available");
      await rm(join(catalog, name));
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("读取失败与确认停用/移除分开，临时资源和清单缺失不要求清除选择", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-theme-selection-"));
  const dataRoot = join(root, "data");
  const source = join(root, "theme");
  await createThemePackage(source);
  const app = await openApplication({ dataRoot, publish: () => {} });
  const packages = createPackageService({ dataRoot, host: "desktop" });
  const inspect = async () =>
    readDesktopThemes(await app.request("package.list", { host: "desktop" }), desktopThemeId);
  try {
    await packages.install(source, "global");
    assert.equal((await inspect()).selection, "available");
    for (const name of ["palettes/light.json", "package.json"]) {
      const path = join(source, name);
      await rename(path, `${path}.updating`);
      assert.equal((await inspect()).selection, "error");
      await rename(`${path}.updating`, path);
      assert.equal((await inspect()).selection, "available");
    }
    await packages.setEnabled(source, "global", false);
    assert.equal((await inspect()).selection, "missing");
    await packages.setEnabled(source, "global", true);
    assert.equal((await inspect()).selection, "available");
    await packages.remove(source, "global");
    assert.equal((await inspect()).selection, "missing");
    // Pi 仍支持无 package.json 的约定目录；其元数据缺失不能掩盖当前主题已移除。
    const legacy = join(root, "legacy-agent");
    await mkdir(legacy);
    await writeFile(join(legacy, "index.ts"), "export default function () {};");
    await createPackageService({ dataRoot }).install(legacy, "global");
    const snapshot = await app.request("package.list", { host: "desktop" });
    assert.equal((await readDesktopThemes(snapshot, desktopThemeId, source)).selection, "missing");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
