import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";

test("插件市场在深浅主题和窄窗口中显示卡片、来源与可键盘关闭的详情", {
  timeout: 60_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "dai-plugin-layout-"));
  const root = join(profile, "data", "catalog");
  await mkdir(root, { recursive: true });
  // 使用可信的本地 HTTPS 目录，完整经过生产请求与内存缓存路径。
  const names = ["Code Review", "团队编码规范", "Documentation Helper"];
  const entries = names.map((name, i) => ({
    entry: {
      sourceId: "company",
      id: `demo-${i}`,
      name,
      description: [
        "从代码变化中梳理潜在问题，帮助团队保持一致的代码质量。",
        "让团队的命名、目录与提交流程成为 Coding 助手的共同知识。",
        "将项目背景与文档规范带入每一次编码协作。",
      ][i],
      publisher: "开发平台组",
      version: "1.2.0",
      installSource: `npm:@company/demo-${i}@1.2.0`,
      resources: [i === 1 ? "skill" : "extension"],
      compatibility: "unknown",
      compatibilityNote: "尚未验证桌面兼容性。",
      homepage: "https://example.com",
    },
    readme:
      "# 使用说明\n\n这是视觉验收使用的测试目录，生产不内置演示插件。\n\n<script>window.fixtureExecuted=true</script>",
    versions: ["1.2.0"],
  }));
  let packages = entries.map(({ entry, readme }) => ({ ...entry, readme }));
  let unavailable = false;
  const key = join(profile, "key.pem");
  const cert = join(profile, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (_request, response) => {
      if (unavailable) {
        response.writeHead(503);
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ schemaVersion: 1, packages }));
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `https://127.0.0.1:${address.port}/catalog.json`;
  await writeFile(join(root, "sources.json"), JSON.stringify({ companyUrl: url }));
  const packageRoot = join(profile, "data", "agent", "packages");
  const installedPath = join(packageRoot, "npm", "node_modules", "@company", "demo-0");
  await mkdir(installedPath, { recursive: true });
  await writeFile(
    join(installedPath, "package.json"),
    JSON.stringify({ name: "@company/demo-0", version: "1.2.0" }),
  );
  await writeFile(
    join(packageRoot, "settings.json"),
    JSON.stringify({ packages: ["npm:@company/demo-0@1.2.0"] }),
  );
  await writeFile(
    join(root, "origins.json"),
    JSON.stringify([
      {
        source: "npm:@company/demo-0@1.2.0",
        host: "pi",
        scope: "global",
        sourceId: "company",
        entryId: "demo-0",
        catalogUrl: url,
      },
    ]),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && e[1] !== undefined,
    ),
  );
  const app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${profile}`],
    env: { ...env, NODE_EXTRA_CA_CERTS: cert },
    chromiumSandbox: true,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(12_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1500, 940),
    );
    await page.getByRole("button", { name: "打开设置", exact: true }).click();
    await page.getByRole("button", { name: "插件与技能", exact: true }).click();
    await page.getByText("为你的 Dai 增加新能力。", { exact: true }).waitFor();
    const footer = page.locator(".settings-footer");
    const footerButtons = await footer.getByRole("button").all();
    const [back, home] = await Promise.all(footerButtons.map((button) => button.boundingBox()));
    assert.ok(back && home && Math.abs(back.x - home.x) < 1 && home.y - back.y - back.height <= 8);
    await page.getByRole("tab", { name: "我的技能", exact: true }).click();
    await page.getByRole("heading", { name: "还没有自己的技能", exact: true }).waitFor();
    await page.getByRole("tab", { name: "发现插件", exact: true }).click();
    await page.getByRole("button", { name: "公司内部", exact: true }).click();
    await page.getByRole("button", { name: "查看 Code Review", exact: true }).waitFor();
    assert.equal(await page.locator(".plugin-card").count(), 3);
    // 列表出现后目录发布新版本：详情和安装确认必须选择新详情中的版本。
    packages = packages.map((item, index) =>
      index === 0
        ? {
            ...item,
            version: "1.3.0",
            installSource: "npm:@company/demo-0@1.3.0",
          }
        : item,
    );
    await page.evaluate(() =>
      window.desktop.application.catalogDetail({
        sourceId: "company",
        id: "demo-0",
        refresh: true,
      }),
    );
    await page.getByRole("tab", { name: /已安装/ }).click();
    const row = page.locator(".plugin-installed-row").filter({ hasText: "@company/demo-0" });
    await row.getByRole("button", { name: "更新", exact: true }).click();
    let updateDialog = page.getByRole("dialog", { name: "更新插件" });
    await updateDialog.getByText("当前 1.2.0 → 市场最新 1.3.0", { exact: true }).waitFor();
    assert.equal(await updateDialog.getByRole("button", { name: "确认更新" }).isEnabled(), true);
    await updateDialog.getByRole("button", { name: "取消" }).click();
    packages = packages.map((item, index) =>
      index === 0
        ? { ...item, version: "1.2.0", installSource: "npm:@company/demo-0@1.2.0" }
        : item,
    );
    await row.getByRole("button", { name: "更新", exact: true }).click();
    updateDialog = page.getByRole("dialog", { name: "更新插件" });
    await updateDialog.getByText("当前已是市场版本 1.2.0。", { exact: true }).waitFor();
    assert.equal(await updateDialog.getByRole("button", { name: "确认更新" }).isDisabled(), true);
    await updateDialog.getByRole("button", { name: "取消" }).click();
    packages = packages.map((item, index) =>
      index === 0
        ? { ...item, version: "1.3.0", installSource: "npm:@company/demo-0@1.3.0" }
        : item,
    );
    unavailable = true;
    await row.getByRole("button", { name: "更新", exact: true }).click();
    updateDialog = page.getByRole("dialog", { name: "更新插件" });
    await updateDialog.getByText("无法获取最新版本，请检查网络后重试。", { exact: true }).waitFor();
    assert.equal(await updateDialog.getByRole("button", { name: "确认更新" }).isDisabled(), true);
    await updateDialog.getByRole("button", { name: "取消" }).click();
    unavailable = false;
    await page.evaluate(() =>
      window.desktop.application.catalogDetail({
        sourceId: "company",
        id: "demo-0",
        refresh: true,
      }),
    );
    await page.getByRole("tab", { name: "发现插件" }).click();
    await page.getByRole("button", { name: "公司内部", exact: true }).click();
    await page.getByRole("button", { name: "查看 Code Review", exact: true }).click();
    const detail = page.getByRole("dialog", { name: "插件详情", exact: true });
    await detail.waitFor();
    await detail.getByRole("heading", { name: "使用说明", exact: true }).first().waitFor();
    await detail.getByRole("tab", { name: "包含内容", exact: true }).click();
    await detail.getByText("功能扩展", { exact: true }).waitFor();
    await detail.getByRole("tab", { name: "概览", exact: true }).click();
    assert.equal(await page.evaluate(() => Object.hasOwn(window, "fixtureExecuted")), false);
    assert.match(
      (await detail.getByRole("button", { name: "安装版本", exact: true }).textContent()) ?? "",
      /1\.3\.0/,
    );
    const basePixelRatio = await page.evaluate(() => devicePixelRatio);
    for (const zoom of [1, 0.6, 1.2, 1]) {
      await app.evaluate(
        ({ BrowserWindow }, value) =>
          BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(value),
        zoom,
      );
      await page.waitForFunction(
        (expected) => Math.abs(devicePixelRatio - expected) < 0.02,
        basePixelRatio * zoom,
      );
      await page.waitForFunction(() => {
        const drawer = document.querySelector(".plugin-detail-drawer")?.getBoundingClientRect();
        const titlebar = document.querySelector(".settings-brand")?.getBoundingClientRect();
        return (
          drawer &&
          titlebar &&
          drawer.top >= titlebar.bottom - 1 &&
          Math.abs(drawer.bottom - innerHeight) < 2
        );
      });
    }
    await detail.getByRole("button", { name: "安装此版本…", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "安装插件", exact: true });
    await confirmation.waitFor();
    assert.match(
      (await confirmation.getByRole("button", { name: "使用范围", exact: true }).textContent()) ??
        "",
      /全局/,
    );
    await confirmation.getByRole("button", { name: "使用范围", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "仅 Coding 模块", exact: true }).click();
    await confirmation
      .getByText("所有 Coding 项目共用，不影响其他模块。", { exact: true })
      .waitFor();
    await confirmation.getByRole("button", { name: "使用范围", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "全局（所有模块）", exact: true }).click();
    assert.match((await confirmation.textContent()) ?? "", /demo-0@1\.3\.0/);
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    await detail.waitFor();
    await page.keyboard.press("Escape");
    await detail.waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "查看 Code Review",
    );
    // 用真实 IPC 错误检验提示与重试，不把 Electron 协议前缀展示给用户。
    await page.evaluate(() => window.desktop.application.configureCatalog({ url: "" }));
    await page.getByRole("button", { name: "查看 Code Review", exact: true }).click();
    await detail.getByRole("alert").waitFor();
    assert.doesNotMatch(
      (await detail.getByRole("alert").textContent()) ?? "",
      /Error invoking remote method|application:request/,
    );
    await page.evaluate(
      (value) => window.desktop.application.configureCatalog({ url: value }),
      url,
    );
    await detail.getByRole("button", { name: "重试", exact: true }).click();
    await detail.getByRole("heading", { name: "使用说明", exact: true }).first().waitFor();
    await detail.getByRole("button", { name: "关闭插件详情", exact: true }).click();
    await detail.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "常规", exact: true }).click();
    await page.getByRole("button", { name: "主题", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "深色", exact: true }).click();
    await page.getByRole("button", { name: "插件与技能", exact: true }).click();
    await page.getByRole("button", { name: "公司内部", exact: true }).click();
    await page.getByRole("button", { name: "查看 Code Review", exact: true }).waitFor();
    for (const width of [1200, 840]) {
      await app.evaluate(
        ({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, 760),
        width,
      );
      await page.waitForFunction((w) => innerWidth === w, width);
      const fits = await page.locator(".plugin-grid").evaluate((grid) => {
        const bounds = grid.getBoundingClientRect();
        return Array.from(grid.querySelectorAll(".plugin-card")).every((c) => {
          const b = c.getBoundingClientRect();
          return b.width >= 240 && b.left >= bounds.left - 1 && b.right <= bounds.right + 1;
        });
      });
      assert.equal(fits, true);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
    }
    assert.equal(await page.getByRole("button", { name: "Dai 内置", exact: true }).count(), 0);
    await page.getByRole("tab", { name: "我的技能", exact: true }).click();
    await page.getByRole("heading", { name: "还没有自己的技能", exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(profile, { recursive: true, force: true });
  }
});
