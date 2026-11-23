import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPackageService } from "../../../src/backend/extensions/package_service.ts";
import { createThemePackage } from "../../support/desktop_theme.ts";

test("Pi packages are discovered, scoped by module, and restored with enabled state", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-package-test-"));
  const dataRoot = join(root, "data");
  const source = join(root, "sample-package");
  try {
    await mkdir(join(source, "extensions"), { recursive: true });
    await mkdir(join(source, "skills", "sample"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "sample-pi-package" }));
    await writeFile(join(source, "extensions", "index.ts"), "export default () => {};\n");
    await writeFile(
      join(source, "skills", "sample", "SKILL.md"),
      "---\nname: sample\ndescription: sample\n---\nSample.\n",
    );

    const a = createPackageService({ dataRoot, moduleId: "coding" });
    const b = createPackageService({ dataRoot, moduleId: "scene" });
    await a.install(source, "module");
    const reopenedAfterInstall = createPackageService({
      dataRoot,
      moduleId: "coding",
    });
    assert.equal(
      (await reopenedAfterInstall.inspect())[0]?.source,
      source,
      "install 返回前必须已经落盘",
    );
    assert.equal((await a.inspect()).length, 1);
    assert.deepEqual(await b.inspect(), []);
    const resolved = await a.resolve();
    assert.equal(resolved.extensions.length, 1);
    assert.equal(resolved.extensions[0]?.metadata.source, source);
    assert.equal(resolved.extensions[0]?.metadata.scope, "project");
    assert.equal((await a.resolve()).skills.length, 1);
    assert.equal((await b.resolve()).extensions.length, 0);

    await a.setEnabled(source, "module", false);
    assert.equal((await a.inspect())[0]?.enabled, false);
    assert.equal((await a.resolve()).extensions.length, 0);
    const reopened = createPackageService({ dataRoot, moduleId: "coding" });
    assert.equal((await reopened.inspect())[0]?.enabled, false);
    await reopened.setEnabled(source, "module", true);
    assert.equal((await reopened.resolve()).extensions.length, 1);
    await reopened.remove(source, "module");
    assert.deepEqual(await reopened.inspect(), []);
    assert.equal(
      (await readFile(join(source, "package.json"), "utf8")).includes("sample-pi-package"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("已有 Agent 包的安装目录丢失时，重装仍须先通过会话检查", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-agent-missing-lock-"));
  const source = join(root, "agent");
  let busy = false;
  const service = createPackageService({
    dataRoot: join(root, "data"),
    async beforeAgentChange() {
      if (busy) throw new Error("Agent busy");
    },
  });
  try {
    await mkdir(source);
    await service.install(source, "global");
    await rename(source, `${source}.moved`);
    busy = true;
    await assert.rejects(service.install(source, "global"), /Agent busy/);
    assert.equal((await service.inspect()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("包模块拒绝越界路径，安装不再依赖项目工作目录", async () => {
  assert.throws(
    () => createPackageService({ dataRoot: "/tmp/dai-test", moduleId: "../other" as "coding" }),
    /模块/,
  );
  const dataRoot = await mkdtemp(join(tmpdir(), "dai-package-relative-"));
  try {
    const service = createPackageService({ dataRoot });
    for (const path of [".", "..", "./plugin", "../plugin", "relative-plugin"])
      await assert.rejects(service.install(path, "global"), /绝对路径/);
    assert.deepEqual(await service.inspect(), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("concurrent global package changes from different modules are not lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-package-concurrent-"));
  try {
    const aPath = join(root, "package-a");
    const bPath = join(root, "package-b");
    await mkdir(aPath);
    await mkdir(bPath);
    await writeFile(join(aPath, "package.json"), JSON.stringify({ name: "package-a" }));
    await writeFile(join(bPath, "package.json"), JSON.stringify({ name: "package-b" }));
    const dataRoot = join(root, "data");
    const a = createPackageService({ dataRoot, moduleId: "coding" });
    const b = createPackageService({ dataRoot, moduleId: "scene" });
    await Promise.all([a.install(aPath, "global"), b.install(bPath, "global")]);
    assert.deepEqual(
      new Set((await a.inspect()).map((item) => item.source)),
      new Set([aPath, bPath]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("同名模块包优先于全局，两个范围分别启停且不自动回退", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-package-priority-"));
  const source = join(root, "pkg");
  try {
    await mkdir(join(source, "extensions"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "demo" }));
    await writeFile(join(source, "extensions", "index.ts"), "export default () => {};\n");
    const coding = createPackageService({ dataRoot: join(root, "data"), moduleId: "coding" });
    const scene = createPackageService({ dataRoot: join(root, "data"), moduleId: "scene" });
    await coding.install(source, "global");
    await coding.install(source, "module");
    assert.equal((await coding.resolve()).extensions[0]?.metadata.scope, "project");
    await coding.setEnabled(source, "global", false);
    assert.equal((await coding.resolve()).extensions.length, 1);
    assert.equal((await scene.resolve()).extensions.length, 0);
    await coding.setEnabled(source, "global", true);
    await coding.setEnabled(source, "module", false);
    assert.equal((await coding.resolve()).extensions.length, 0);
    assert.equal((await scene.resolve()).extensions.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi 与 Desktop 使用独立配置和操作队列，读取快照不会修改配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-package-hosts-"));
  const dataRoot = join(root, "data");
  const piSource = join(root, "pi");
  const desktopSource = join(root, "desktop");
  const pi = createPackageService({ dataRoot });
  const desktop = createPackageService({ dataRoot, host: "desktop" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let writing: Promise<void> | undefined;
  try {
    await mkdir(piSource);
    await writeFile(join(piSource, "index.ts"), "export default () => {};");
    await createThemePackage(desktopSource);
    await pi.install(piSource, "global");
    await desktop.install(desktopSource, "global");
    const piPath = join(dataRoot, "agent/packages/settings.json");
    const desktopPath = join(dataRoot, "desktop/packages/settings.json");
    const before = await Promise.all([readFile(piPath, "utf8"), readFile(desktopPath, "utf8")]);
    assert.deepEqual(
      (await pi.inspect()).map((item) => item.host),
      ["pi"],
    );
    assert.deepEqual(
      (await desktop.inspect()).map((item) => item.host),
      ["desktop"],
    );
    assert.deepEqual(
      await Promise.all([readFile(piPath, "utf8"), readFile(desktopPath, "utf8")]),
      before,
    );
    assert.doesNotMatch(before.join(""), /daiHost|"extensions"/);

    // 人为挂起 Pi 变更，Desktop 读写仍应完成；两个宿主不共用同一把包锁。
    const writer = createPackageService({
      dataRoot,
      async beforeAgentChange() {
        started();
        await gate;
      },
    });
    writing = writer.setEnabled(piSource, "global", false);
    await ready;
    await desktop.setEnabled(desktopSource, "global", false);
    assert.equal((await desktop.inspect())[0]?.enabled, false);
    release();
    await writing;
    assert.equal((await pi.inspect())[0]?.enabled, false);
  } finally {
    release();
    await writing;
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop 忽略遗留模块设置，默认启用不创建多余状态文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-desktop-global-"));
  const dataRoot = join(root, "data");
  const source = join(root, "theme");
  const legacy = join(dataRoot, "desktop/packages/modules/coding/settings.json");
  try {
    await createThemePackage(source);
    await mkdir(join(dataRoot, "desktop/packages/modules/coding"), { recursive: true });
    const text = JSON.stringify({ packages: [source] });
    await writeFile(legacy, text);
    const desktop = createPackageService({ dataRoot, host: "desktop" });
    assert.deepEqual(await desktop.inspect(), [], "Desktop 不读取 SDK 的 project 配置");
    await desktop.install(source, "global");
    const packages = await desktop.inspect();
    assert.equal(packages.length, 1);
    assert.equal(packages[0]?.scope, "global");
    await assert.rejects(readFile(join(dataRoot, "desktop/packages/disabled.json")), {
      code: "ENOENT",
    });
    assert.equal(await readFile(legacy, "utf8"), text, "快照与安装不能重写遗留模块文件");
    assert.deepEqual(await createPackageService({ dataRoot }).inspect(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 列表诊断与加载门禁共用清单解析，但停用的损坏包不能阻断其他资源。
test("清单损坏保留列表诊断，停用后可加载，重新启用仍须通过宿主校验", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-package-manifest-"));
  const source = join(root, "sample");
  const manifestPath = join(source, "package.json");
  const service = createPackageService({ dataRoot: join(root, "data") });
  try {
    await mkdir(source);
    await writeFile(manifestPath, JSON.stringify({ name: "sample" }));
    await service.install(source, "global");
    await writeFile(manifestPath, "{");
    assert.ok((await service.inspect())[0]?.manifestError);
    await assert.rejects(service.resolve());
    await service.setEnabled(source, "global", false);
    assert.equal((await service.resolve()).extensions.length, 0);
    await assert.rejects(service.setEnabled(source, "global", true));

    await createThemePackage(source);
    const [item] = await service.inspect();
    assert.equal(item?.host, "pi");
    assert.match(item?.manifestError ?? "", /宿主不匹配/);
    await assert.rejects(service.setEnabled(source, "global", true), /宿主不匹配/);
    assert.equal((await service.inspect())[0]?.enabled, false);

    await writeFile(manifestPath, JSON.stringify({ name: "sample" }));
    await service.setEnabled(source, "global", true);
    assert.equal((await service.inspect())[0]?.manifestError, "");
    await service.resolve();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
