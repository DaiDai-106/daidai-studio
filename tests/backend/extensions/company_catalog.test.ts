import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { openApplication } from "../../../src/backend/application.ts";
import {
  allowedCompanyPackage,
  companyCatalogUrl,
} from "../../../src/backend/extensions/company_catalog.ts";
import { waitForCatalogTask } from "../../support/catalog_task.ts";
import { createThemePackage } from "../../support/desktop_theme.ts";

const execute = promisify(execFile);

async function commit(directory: string) {
  await execute("git", ["-C", directory, "add", "."]);
  await execute("git", [
    "-C",
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "fixture",
  ]);
}

test("公司目录只接受 HTTPS JSON 或受支持的 Git 地址，SSH 用户名不视为密码", () => {
  assert.equal(
    companyCatalogUrl("git:ssh://git@gitlab.example/team/catalog.git"),
    "git:ssh://git@gitlab.example/team/catalog.git",
  );
  assert.ok(allowedCompanyPackage("git:ssh://git@gitlab.example/team/theme.git@v1.0.0"));
  for (const source of [
    "http://example.com/catalog.json",
    "git:file:///tmp/repo",
    "git:ssh://user:secret@example.com/repo",
    "https://user:secret@example.com/catalog.json",
  ])
    assert.throws(() => companyCatalogUrl(source));
  assert.equal(allowedCompanyPackage("/tmp/theme"), false);
  assert.equal(allowedCompanyPackage("http://example.com/repo.git"), false);
});

test("Git 公司目录可刷新，主题可经现有 Pi Git 安装、更新并保留所选方案", {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-git-catalog-"));
  const catalog = join(root, "catalog");
  const plugin = join(root, "plugin");
  const catalogUrl = "git:ssh://git@catalog.example/team/catalog.git";
  const installSource = "git:ssh://git@plugin.example/team/theme.git";
  const previous = process.env.GIT_CONFIG_GLOBAL;
  await mkdir(catalog);
  await createThemePackage(plugin);
  await execute("git", ["init", "--quiet", catalog]);
  await execute("git", ["init", "--quiet", plugin]);
  const config = join(root, "gitconfig");
  await writeFile(
    config,
    `[protocol "file"]\n allow = always\n[url "file://${catalog}"]\n insteadOf = ssh://git@catalog.example/team/catalog.git\n[url "file://${plugin}"]\n insteadOf = ssh://git@plugin.example/team/theme.git\n`,
  );
  process.env.GIT_CONFIG_GLOBAL = config;
  const entry = {
    id: "paper",
    name: "Paper",
    description: "桌面主题",
    publisher: "Test",
    version: "1.0.0",
    resources: ["desktop-theme"],
    installSource,
    homepage: "https://example.com/theme",
  };
  const saveCatalog = () =>
    writeFile(
      join(catalog, "catalog.json"),
      JSON.stringify({ schemaVersion: 1, packages: [entry] }),
    );
  await saveCatalog();
  await commit(catalog);
  await commit(plugin);
  const app = await openApplication({ dataRoot: join(root, "data"), publish: () => {} });
  try {
    await app.request("catalog.configure", { url: catalogUrl });
    const stored = JSON.parse(await readFile(join(root, "data/catalog/sources.json"), "utf8"));
    assert.equal(stored.companyUrl, catalogUrl);
    const groups = await app.request("catalog.search", {
      sourceId: "company",
      query: "",
      offset: 0,
    });
    assert.equal(groups[0]?.error, "");
    assert.deepEqual(groups[0]?.entries[0]?.resources, ["desktop-theme"]);
    await assert.rejects(
      app.request("catalog.install", {
        sourceId: "company",
        id: entry.id,
        version: entry.version,
        scope: "module",
        moduleId: "coding",
      }),
      /全局安装/,
    );
    const task = await app.request("catalog.install", {
      sourceId: "company",
      id: entry.id,
      version: entry.version,
      scope: "global",
    });
    const result = await waitForCatalogTask(() => app.request("catalog.tasks", {}), task.id);
    assert.equal(result.state, "completed", result.message);
    assert.equal((await app.request("catalog.installed", {}))[0]?.sourceId, "company");

    const manifestPath = join(plugin, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "1.1.0";
    await writeFile(manifestPath, JSON.stringify(manifest));
    const palettePath = join(plugin, "palettes/light.json");
    const palette = JSON.parse(await readFile(palettePath, "utf8"));
    palette.variables["--surface"] = "#f3f0e4";
    await writeFile(palettePath, JSON.stringify(palette));
    await commit(plugin);
    entry.version = "1.1.0";
    await saveCatalog();
    await commit(catalog);
    const detail = await app.request("catalog.detail", {
      sourceId: "company",
      id: entry.id,
      refresh: true,
    });
    assert.equal(detail.entry.version, "1.1.0");
    const update = await app.request("catalog.install", {
      sourceId: "company",
      id: entry.id,
      version: entry.version,
      scope: "global",
      replaceSource: installSource,
    });
    const updated = await waitForCatalogTask(() => app.request("catalog.tasks", {}), update.id);
    assert.equal(updated.state, "completed", updated.message);
    assert.equal((await app.request("catalog.installed", {}))[0]?.version, "1.1.0");
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
    await rm(root, { recursive: true, force: true });
  }
});
