import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../../src/backend/application.ts";
import { createCatalogService } from "../../../src/backend/extensions/catalog_service.ts";
import { createPackageService } from "../../../src/backend/extensions/package_service.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";
import { type ApplicationEvent, validateResult } from "../../../src/contracts/application.ts";
import { runPackageAction, waitForCatalogTask } from "../../support/catalog_task.ts";
import { createThemePackage } from "../../support/desktop_theme.ts";

test("来源关联损坏时仍能列出插件，并在移除前报告错误", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-invalid-origins-"));
  const dataRoot = join(root, "data");
  const source = join(root, "plugin");
  const catalog = createCatalogService({ dataRoot, publish() {}, async changed() {} });
  try {
    await mkdir(source);
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "test-plugin" }));
    await createPackageService({ dataRoot }).install(source, "global");
    await mkdir(join(dataRoot, "catalog"), { recursive: true });
    await writeFile(join(dataRoot, "catalog", "origins.json"), "{invalid");
    const task = catalog.start({ action: "remove", source, scope: "global" });
    const result = await waitForCatalogTask(() => catalog.taskList(), task.id);
    assert.equal(result.state, "failed");
    assert.match(result.message, /损坏/);
    assert.equal((await catalog.installed())[0]?.source, source);
  } finally {
    await catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("损坏的单条来源回退为手动来源，其他记录仍可使用", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-partial-origins-"));
  const dataRoot = join(root, "data");
  const source = join(root, "plugin");
  const catalog = createCatalogService({ dataRoot, publish() {}, async changed() {} });
  try {
    await mkdir(source);
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "test-plugin" }));
    const packages = createPackageService({ dataRoot });
    await packages.install(source, "global");
    await packages.install(source, "module");
    const directory = join(dataRoot, "catalog");
    await mkdir(directory, { recursive: true });
    const origin = { source, host: "pi", sourceId: "pi" };
    const moduleOrigin = { ...origin, scope: "module", moduleId: "coding" };
    await writeFile(
      join(directory, "origins.json"),
      JSON.stringify([
        null,
        { ...origin, scope: "global", entryId: 42 },
        { ...moduleOrigin, entryId: "x".repeat(501) },
        { ...moduleOrigin, entryId: "test-plugin" },
      ]),
    );
    const installed = await catalog.installed();
    validateResult("catalog.installed", installed);
    assert.equal(installed.find((item) => item.scope === "global")?.sourceId, "manual");
    assert.equal(installed.find((item) => item.scope === "module")?.entryId, "test-plugin");

    const task = catalog.start({ action: "remove", source, scope: "global" });
    assert.equal((await waitForCatalogTask(catalog.taskList, task.id)).state, "completed");
    const [remaining] = await catalog.installed();
    assert.equal(remaining?.entryId, "test-plugin");
    assert.equal(remaining?.scope, "module");
  } finally {
    await catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("移除提交后来源关联写入失败时，任务如实报告结果", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-origins-save-failure-"));
  const dataRoot = join(root, "data");
  const source = join(root, "plugin");
  const catalog = createCatalogService({
    dataRoot,
    publish() {},
    async changed() {
      await mkdir(join(dataRoot, "catalog", "origins.json"), { recursive: true });
    },
  });
  try {
    await mkdir(source);
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "test-plugin" }));
    await createPackageService({ dataRoot }).install(source, "global");
    const task = catalog.start({ action: "remove", source, scope: "global" });
    const result = await waitForCatalogTask(() => catalog.taskList(), task.id);
    assert.equal(result.state, "completed");
    assert.match(result.message, /已移除.*来源关联保存失败/);
    assert.deepEqual(await catalog.installed(), []);
  } finally {
    await catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dai-catalog-"));
  const events: ApplicationEvent[] = [];
  const app = await openApplication({
    dataRoot: join(root, "data"),
    publish: (e) => events.push(e),
  });
  return {
    root,
    app,
    events,
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("Desktop 操作独立于 Agent 锁，Pi 操作受锁保护且混合包拒绝安装", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-desktop-package-lock-"));
  const dataRoot = join(root, "data");
  const source = join(root, "theme");
  let locks = 0;
  const catalog = createCatalogService({
    dataRoot,
    publish() {},
    async changed() {
      locks++;
      throw new Error("请先停止相关会话。");
    },
  });
  const service = createPackageService({ dataRoot });
  try {
    await createThemePackage(source);
    const agent = join(root, "agent");
    await mkdir(agent);
    await writeFile(
      join(agent, "package.json"),
      JSON.stringify({ name: "agent", pi: { extensions: ["index.ts"] } }),
    );
    await writeFile(join(agent, "index.ts"), "export default () => {};");
    await service.install(agent, "global");
    catalog.recordLoad("coding", [{ source: agent, scope: "global", error: "" }]);
    for (const action of ["install", "update", "disable", "enable", "remove"] as const) {
      const task = catalog.start({ source, host: "desktop", scope: "global", action });
      const result = await waitForCatalogTask(catalog.taskList, task.id);
      assert.equal(result.state, "completed", `${action}: ${result.message}`);
      assert.equal(locks, 0);
      assert.equal(
        (await catalog.installed()).find((p) => p.source === agent)?.loadState,
        "loaded",
      );
    }
    for (const action of ["install", "update", "disable", "enable", "remove"] as const) {
      const task = catalog.start({ source: agent, scope: "global", action });
      assert.equal((await waitForCatalogTask(catalog.taskList, task.id)).state, "failed");
    }
    const path = join(source, "package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.pi = { extensions: ["index.ts"] };
    await writeFile(path, JSON.stringify(manifest));
    await writeFile(join(source, "index.ts"), "export default () => {};");
    const mixed = catalog.start({ source, host: "desktop", scope: "global", action: "install" });
    assert.equal((await waitForCatalogTask(catalog.taskList, mixed.id)).state, "failed");
    assert.equal(
      (await service.inspect()).some((p) => p.source === source),
      false,
    );
    assert.equal(locks, 5);
  } finally {
    await catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("目录搜索使用 npm 元数据、来源独立失败、缓存可离线恢复且不执行扩展", async () => {
  const f = await fixture();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls++;
    assert.match(String(input), /^https:\/\/registry.npmjs.org\//);
    return Response.json({
      objects: [
        {
          package: {
            name: "test-pi-package",
            version: "1.0.0",
            keywords: ["pi-package"],
            description: "Test",
            publisher: { username: "author" },
          },
        },
      ],
      total: 30,
    });
  };
  try {
    const result = await f.app.request("catalog.search", { query: "test", offset: 0 });
    assert.equal(result.length, 2);
    assert.equal(result[0]?.entries[0]?.id, "test-pi-package");
    assert.equal(result[0]?.entries[0]?.compatibility, "unknown");
    assert.equal(result[0]?.nextOffset, 24);
    assert.equal(calls, 2);
    globalThis.fetch = async () => {
      throw new TypeError("offline");
    };
    const cached = await f.app.request("catalog.search", {
      query: "test",
      offset: 0,
      refresh: true,
    });
    assert.equal(cached[0]?.cached, true);
    assert.equal(cached[0]?.entries.length, 1);
    assert.match(cached[0]?.error ?? "", /无法连接/);
    await assert.rejects(
      f.app.request("catalog.configure", { url: "https://user:secret@example.com/catalog.json" }),
    );
    await assert.rejects(
      f.app.request("catalog.configure", { url: "http://example.com/catalog.json" }),
    );
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});

test("npm 详情从 Pi manifest 发现资源，安装前重新验证被撤回的版本", async () => {
  const f = await fixture();
  const original = globalThis.fetch;
  let withdrawn = false;
  globalThis.fetch = async (input) => {
    const manifest = {
      name: "demo",
      version: "1.0.0",
      keywords: ["pi-package"],
      pi: { extensions: ["index.ts"], skills: ["skills"] },
      ...(withdrawn ? { deprecated: "withdrawn" } : {}),
    };
    if (String(input).startsWith("https://registry.npmjs.org/demo/"))
      return Response.json(manifest);
    return Response.json({
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": manifest },
      readme: "# Demo",
    });
  };
  try {
    const detail = await f.app.request("catalog.detail", { sourceId: "pi", id: "demo" });
    assert.deepEqual(detail.entry.resources, ["extension", "skill"]);
    assert.equal(detail.readme, "# Demo");
    withdrawn = true;
    await assert.rejects(
      f.app.request("catalog.install", {
        sourceId: "pi",
        id: "demo",
        version: "1.0.0",
        scope: "global",
      }),
      /版本已不可用/,
    );
    assert.deepEqual(await f.app.request("catalog.installed", {}), []);
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});

test("完整 npm 历史超限不阻断详情，重试绕过缓存，安装只复核所选版本", async () => {
  const f = await fixture();
  const original = globalThis.fetch;
  let oversized = true;
  let cancelled = false;
  let latest = "1.0.0";
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/large-demo")) {
      if (!oversized)
        return Response.json({ versions: { "1.0.0": {}, "1.1.0": {} }, readme: "# Updated" });
      let count = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (count++ < 10) controller.enqueue(new Uint8Array(1_000_000).fill(32));
            else controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    }
    return Response.json({
      name: "large-demo",
      version: url.endsWith("/latest") ? latest : "1.0.0",
      keywords: ["pi-package"],
      pi: { extensions: ["index.ts"] },
      ...(url.endsWith("/1.0.0") ? { deprecated: "withdrawn" } : {}),
    });
  };
  try {
    await assert.rejects(
      f.app.request("catalog.detail", { sourceId: "pi", id: "../invalid" }),
      /包名无效/,
    );
    assert.deepEqual(calls, [], "无效包名不能触发单版本或完整历史请求");
    const detail = await f.app.request("catalog.detail", { sourceId: "pi", id: "large-demo" });
    assert.equal(detail.entry.version, "1.0.0");
    assert.deepEqual(detail.versions, ["1.0.0"]);
    assert.match(detail.notice ?? "", /完整说明和历史版本暂不可用/);
    assert.equal(cancelled, true, "超限后应取消读取响应流");
    await f.app.request("catalog.detail", { sourceId: "pi", id: "large-demo" });
    assert.equal(calls.length, 2, "普通打开可复用详情缓存");
    oversized = false;
    latest = "1.1.0";
    const refreshed = await f.app.request("catalog.detail", {
      sourceId: "pi",
      id: "large-demo",
      refresh: true,
    });
    assert.equal(refreshed.entry.version, "1.1.0");
    assert.equal(refreshed.readme, "# Updated");
    assert.equal(refreshed.notice, undefined);
    calls.length = 0;
    await assert.rejects(
      f.app.request("catalog.install", {
        sourceId: "pi",
        id: "large-demo",
        version: "1.0.0",
        scope: "global",
      }),
      /版本已不可用/,
    );
    assert.deepEqual(calls, ["https://registry.npmjs.org/large-demo/1.0.0"]);
    assert.deepEqual(await f.app.request("catalog.installed", {}), []);
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});

test("后台任务复用 Pi 安装、启停和移除；已安装版本来自本地 manifest", async () => {
  const f = await fixture();
  const pkg = join(f.root, "package");
  await mkdir(join(pkg, "skills", "demo"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "test-local", version: "1.2.3", pi: { skills: ["skills"] } }),
  );
  await writeFile(
    join(pkg, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: demo\n---\nSkill instructions\n",
  );
  const options = { source: pkg, scope: "global" } as const;
  try {
    await runPackageAction(f.app, { ...options, action: "install" });
    const installed = await f.app.request("catalog.installed", {});
    assert.equal(installed[0]?.version, "1.2.3");
    assert.equal(installed[0]?.sourceId, "manual");
    assert.equal(installed[0]?.loadState, "waiting");
    await runPackageAction(f.app, { ...options, action: "disable" });
    assert.equal((await f.app.request("catalog.installed", {}))[0]?.loadState, "disabled");
    await runPackageAction(f.app, { ...options, action: "install" });
    assert.equal((await f.app.request("catalog.installed", {}))[0]?.enabled, true);
    await runPackageAction(f.app, { ...options, action: "remove" });
    assert.deepEqual(await f.app.request("catalog.installed", {}), []);
    assert.match(await readFile(join(pkg, "package.json"), "utf8"), /test-local/);
    assert.ok(f.events.some((e) => e.type === "catalog.task" && e.task.state === "completed"));
  } finally {
    await f.close();
  }
});

test("公司目录校验来源和去重，不接受目录自行授予的兼容认证", async () => {
  const f = await fixture();
  const original = globalThis.fetch;
  const entry = {
    id: "company-demo",
    name: "Company demo",
    description: "Demo",
    publisher: "Team",
    version: "1.0.0",
    installSource: "npm:@team/demo@1.0.0",
    resources: ["skill"],
    homepage: "https://example.com",
    compatibility: "verified",
    compatibilityNote: "trusted",
  };
  globalThis.fetch = async () => Response.json({ schemaVersion: 1, packages: [entry] });
  try {
    await f.app.request("catalog.configure", { url: "https://example.com/catalog.json" });
    const result = await f.app.request("catalog.search", {
      sourceId: "company",
      query: "",
      offset: 0,
    });
    assert.equal(result[0]?.entries[0]?.compatibility, "unknown");
    globalThis.fetch = async () =>
      Response.json({
        schemaVersion: 1,
        packages: [{ ...entry, installSource: "file:/tmp/evil" }],
      });
    const rejected = await f.app.request("catalog.search", {
      sourceId: "company",
      query: "",
      offset: 0,
      refresh: true,
    });
    assert.match(rejected[0]?.error ?? "", /无效/);
    assert.equal(rejected[0]?.cached, true);
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});

test("一个包内任意扩展加载失败都保留包级诊断，下次成功加载可恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-catalog-load-"));
  const store = openProjectStore(join(root, "data"));
  const catalog = createCatalogService({
    dataRoot: join(root, "data"),
    publish() {},
    async changed() {},
  });
  try {
    const pkg = join(root, "pkg");
    await mkdir(pkg);
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "multi-extension" }));
    const install = { source: pkg, scope: "global", action: "install" } as const;
    catalog.start(install);
    assert.throws(() => catalog.start(install), /已有插件操作进行中/);
    await catalog.close();
    assert.throws(() => catalog.start(install), /应用正在退出/);
    catalog.recordLoad("coding", [
      { source: pkg, scope: "global", error: "first extension failed" },
      { source: pkg, scope: "global", error: "" },
    ]);
    const [failed] = await catalog.installed();
    assert.equal(failed?.loadState, "failed");
    assert.equal(failed?.error, "first extension failed");
    catalog.recordLoad("coding", [{ source: pkg, scope: "global", error: "" }]);
    assert.equal((await catalog.installed())[0]?.loadState, "loaded");
  } finally {
    await catalog.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("切换公司目录后缓存仍属于原地址，离线详情明确提示缓存", async () => {
  const f = await fixture();
  const original = globalThis.fetch;
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const a = "https://a.example/catalog.json";
  const b = "https://b.example/catalog.json";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === a) {
      started();
      await waiting;
    }
    return Response.json({
      schemaVersion: 1,
      packages: [
        {
          id: "shared",
          name: url === a ? "Team A" : "Team B",
          description: "Team plugin",
          publisher: "Team",
          version: "1.0.0",
          installSource: "npm:@team/plugin@1.0.0",
          resources: ["skill"],
          homepage: "https://example.com",
        },
      ],
    });
  };
  try {
    await f.app.request("catalog.configure", { url: a });
    const first = f.app.request("catalog.search", { sourceId: "company", query: "", offset: 0 });
    await ready;
    await f.app.request("catalog.configure", { url: b });
    release();
    assert.equal((await first)[0]?.entries[0]?.name, "Team A");
    const second = await f.app.request("catalog.search", {
      sourceId: "company",
      query: "",
      offset: 0,
    });
    assert.equal(second[0]?.entries[0]?.name, "Team B");
    globalThis.fetch = async () => {
      throw new TypeError("offline");
    };
    const detailB = await f.app.request("catalog.detail", {
      sourceId: "company",
      id: "shared",
      refresh: true,
    });
    assert.equal(detailB.entry.name, "Team B");
    assert.match(detailB.notice ?? "", /缓存/);
    await f.app.request("catalog.configure", { url: a });
    const detailA = await f.app.request("catalog.detail", {
      sourceId: "company",
      id: "shared",
      refresh: true,
    });
    assert.equal(detailA.entry.name, "Team A");
  } finally {
    release();
    globalThis.fetch = original;
    await f.close();
  }
});

test("重装停用插件时，并发会话只能读取安装并启用后的资源", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-install-activation-"));
  const dataRoot = join(root, "data");
  const source = join(root, "plugin");
  const packages = createPackageService({ dataRoot });
  let during: ReturnType<typeof packages.resolve> | undefined;
  let invalidations = 0;
  const catalog = createCatalogService({
    dataRoot,
    publish() {},
    async changed() {
      invalidations++;
      // 模拟旧会话释放后，新会话立刻请求资源；不能等待它，否则会等待自己持有的包锁。
      during = packages.resolve();
    },
  });
  try {
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ name: "activation", pi: { extensions: ["index.ts"] } }),
    );
    await writeFile(join(source, "index.ts"), "export default () => {};");
    await packages.install(source, "global");
    await packages.setEnabled(source, "global", false);
    const task = catalog.start({ source, scope: "global", action: "install" });
    const result = await waitForCatalogTask(catalog.taskList, task.id);
    assert.equal(result.state, "completed", result.message);
    assert.ok(during);
    assert.equal((await during).extensions.length, 1);
    assert.equal(invalidations, 1);
    assert.equal((await packages.inspect())[0]?.enabled, true);
  } finally {
    await catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("两个市场可发现不同宿主，条目类型冲突和混合资源被拒绝", async () => {
  const f = await fixture();
  const original = globalThis.fetch;
  let mixed = false;
  let wrongHost = false;
  globalThis.fetch = async (input) => {
    if (String(input) === "https://company.example/catalog.json")
      return Response.json({
        schemaVersion: 1,
        packages: [
          {
            id: "company-pi",
            name: "Company Pi",
            description: "",
            publisher: "Team",
            version: "1.0.0",
            installSource: "npm:company-pi@1.0.0",
            resources: ["skill"],
            homepage: "",
          },
          {
            id: "company-theme",
            name: "Company theme",
            host: wrongHost ? "pi" : "desktop",
            description: "",
            publisher: "Team",
            version: "1.0.0",
            installSource: "npm:company-theme@1.0.0",
            resources: ["desktop-theme"],
            homepage: "",
          },
        ],
      });
    const manifest = {
      name: String(input).includes("/mixed-new") ? "mixed-new" : "mcp-colors",
      version: "1.0.0",
      keywords: ["pi-package"],
      dai: { host: "daidai_pi", schemaVersion: 1, themes: [] },
      ...(mixed ? { pi: { extensions: ["index.ts"] } } : {}),
    };
    return Response.json(
      String(input).endsWith("/latest") ? manifest : { versions: { "1.0.0": manifest } },
    );
  };
  try {
    const publicTheme = await f.app.request("catalog.detail", { sourceId: "pi", id: "mcp-colors" });
    assert.equal(publicTheme.entry.host, "desktop");
    assert.equal(publicTheme.entry.compatibility, "unknown", "包名不决定宿主兼容性");
    await f.app.request("catalog.configure", { url: "https://company.example/catalog.json" });
    const [company] = await f.app.request("catalog.search", {
      sourceId: "company",
      query: "",
      offset: 0,
    });
    assert.deepEqual(
      company?.entries.map((entry) => entry.host),
      ["pi", "desktop"],
    );
    wrongHost = true;
    const [rejected] = await f.app.request("catalog.search", {
      sourceId: "company",
      query: "",
      offset: 0,
      refresh: true,
    });
    assert.match(rejected?.error ?? "", /无效/);
    mixed = true;
    // 使用新条目绕过旧缓存，确认实际清单不接受两个宿主的资源。
    const cached = await f.app.request("catalog.detail", {
      sourceId: "pi",
      id: "mcp-colors",
      refresh: true,
    });
    assert.match(cached.notice ?? "", /缓存/);
    await assert.rejects(
      f.app.request("catalog.detail", { sourceId: "pi", id: "mixed-new" }),
      /混合/,
    );
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});

test("启动迁移旧市场目录并保留配置和 Git 索引，已有新目录时不覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-catalog-relocate-"));
  const legacy = join(root, "agent/catalog");
  const current = join(root, "catalog");
  const config = { companyUrl: "https://company.example/catalog.json" };
  try {
    await mkdir(join(legacy, "git"), { recursive: true });
    await writeFile(join(legacy, "sources.json"), JSON.stringify(config));
    await writeFile(join(legacy, "origins.json"), "[]");
    await writeFile(join(legacy, "git/index-marker"), "retained");
    const first = await openApplication({ dataRoot: root, publish() {} });
    try {
      assert.deepEqual(await first.request("catalog.sources", {}), config);
      assert.equal(await readFile(join(current, "origins.json"), "utf8"), "[]");
      assert.equal(await readFile(join(current, "git/index-marker"), "utf8"), "retained");
      await assert.rejects(readFile(join(legacy, "sources.json")), { code: "ENOENT" });
    } finally {
      await first.close();
    }
    // 用户已在新目录配置过来源时，遗留目录不能覆盖它。
    await mkdir(legacy);
    await writeFile(join(legacy, "sources.json"), "{}");
    const second = await openApplication({ dataRoot: root, publish() {} });
    try {
      assert.deepEqual(await second.request("catalog.sources", {}), config);
      assert.equal(await readFile(join(legacy, "sources.json"), "utf8"), "{}");
    } finally {
      await second.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("任务来源统一后与安装快照一致，含密码的 URL 不进入任务记录", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-source-normalization-"));
  const source = join(root, "plugin");
  const catalog = createCatalogService({
    dataRoot: join(root, "data"),
    publish() {},
    async changed() {},
  });
  try {
    for (const source of [
      "https://name:secret@example.invalid/plugin.git",
      "git:ssh://git:secret@example.invalid/plugin.git",
    ])
      assert.throws(() => catalog.start({ source, scope: "global", action: "install" }), /凭据/);
    assert.deepEqual(catalog.taskList(), []);
    await mkdir(source);
    const task = catalog.start({ source: `  ${source}\n`, scope: "global", action: "install" });
    assert.equal(task.source, source);
    assert.equal((await waitForCatalogTask(catalog.taskList, task.id)).state, "completed");
    assert.equal((await catalog.installed())[0]?.source, source);
  } finally {
    await catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("同一来源的全局和模块诊断独立，模块变更不清空其他模块结果", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-load-scope-"));
  const dataRoot = join(root, "data");
  const source = join(root, "plugin");
  const catalog = createCatalogService({ dataRoot, publish() {}, async changed() {} });
  const packages = createPackageService({ dataRoot });
  try {
    await mkdir(source);
    await packages.install(source, "global");
    await packages.install(source, "module");
    catalog.recordLoad("coding", [{ source, scope: "module", error: "" }]);
    let installed = await catalog.installed();
    assert.equal(installed.find((item) => item.scope === "module")?.loadState, "loaded");
    assert.equal(installed.find((item) => item.scope === "global")?.loadState, "waiting");
    catalog.recordLoad("coding", [{ source, scope: "global", error: "global failed" }]);
    installed = await catalog.installed();
    assert.equal(installed.find((item) => item.scope === "global")?.loadState, "failed");
    assert.equal(installed.find((item) => item.scope === "module")?.loadState, "loaded");
    catalog.recordLoad("robot", [{ source, scope: "global", error: "" }]);
    const task = catalog.start({ source, scope: "module", moduleId: "coding", action: "disable" });
    assert.equal((await waitForCatalogTask(catalog.taskList, task.id)).state, "completed");
    assert.equal((await catalog.installed("robot"))[0]?.loadState, "loaded");
  } finally {
    await catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});
