import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WebContentsView } from "electron";
import { type ElectronApplication, _electron as electron } from "playwright";
import { chooseProject } from "./support.ts";

async function waitForView(app: ElectronApplication, expected: boolean | null) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const actual = await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as
        | WebContentsView
        | undefined;
      return view ? view.getVisible() : null;
    });
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`预览可见状态未变为 ${expected}`);
}

test("本地网页和代码使用独立内容标签，网页受隔离且关闭时释放", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-preview-ui-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "file.ts"), "const value = 1;\n");
  await writeFile(join(project, "index.html"), '<h1>项目页面</h1><script src="app.js"></script>');
  await writeFile(join(project, "app.js"), 'document.body.dataset.loaded = "yes";');
  let outsideHits = 0;
  const outside = createServer((_req, res) => {
    outsideHits++;
    res.end("outside");
  });
  outside.listen(0, "127.0.0.1");
  await once(outside, "listening");
  const outsideAddress = outside.address();
  assert.ok(outsideAddress && typeof outsideAddress !== "string");
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<h1>本地页面</h1><script>document.body.dataset.bridge = String(typeof window.desktop); fetch('http://127.0.0.1:${outsideAddress.port}/').then(() => { document.body.dataset.cross = 'allowed' }).catch(() => { document.body.dataset.cross = 'blocked' }); const socket = new WebSocket('ws://' + location.host + '/hmr'); socket.onopen = () => { document.body.dataset.ws = 'open'; };</script>`,
    );
  });
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({
      args: [process.cwd(), `--user-data-dir=${join(root, "profile")}`],
      env,
      chromiumSandbox: true,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900),
    );
    await chooseProject(app, page, project, "coding");
    await page.getByRole("button", { name: "展开代码工作区" }).click();
    const limits = await page.evaluate(async (port) => {
      const api = window.desktop;
      const projectId = (await api.application.getWorkspace()).projects[0]?.id;
      if (!projectId) throw new Error("缺少项目");
      const ids = Array.from({ length: 12 }, () => crypto.randomUUID());
      const opening = Promise.allSettled(
        ids.map((id) => api.preview.open(projectId, id, `http://127.0.0.1:${port}/`)),
      );
      await Promise.all(ids.map((id) => api.preview.control(projectId, id, "close")));
      return (await opening).filter(
        (result) => result.status === "rejected" && String(result.reason).includes("最多打开 10"),
      ).length;
    }, address.port);
    assert.equal(limits, 2, "并发初始化也占用预览名额");
    await waitForView(app, null);
    await page.getByRole("button", { name: "file.ts", exact: true }).click();
    await page.getByRole("region", { name: "文件内容" }).waitFor();
    await page.getByRole("button", { name: "＋ 网页预览" }).click();
    await page
      .getByRole("textbox", { name: "网页预览地址" })
      .fill(`http://127.0.0.1:${address.port}/`);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await page.waitForFunction(() => {
      const text = document.querySelector(".web-preview-status")?.textContent ?? "";
      return text.includes("127.0.0.1") && !text.includes("加载中");
    });
    await waitForView(app, true);
    const inspection = await app.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as
        | WebContentsView
        | undefined;
      if (!view) return null;
      return {
        visible: view.getVisible(),
        url: view.webContents.getURL(),
        body: await view.webContents.executeJavaScript(
          `new Promise((resolve) => {
            const done = () => { if (document.body.dataset.cross && document.body.dataset.ws) resolve({text: document.body.innerText, bridge: document.body.dataset.bridge, cross: document.body.dataset.cross, ws: document.body.dataset.ws}); else setTimeout(done, 20); };
            done();
          })`,
        ),
      };
    });
    assert.ok(inspection);
    assert.equal(inspection.visible, true);
    assert.match(inspection.url, /127\.0\.0\.1/);
    assert.equal(inspection.body.text, "本地页面");
    assert.equal(inspection.body.bridge, "undefined");
    assert.equal(inspection.body.cross, "blocked");
    assert.equal(inspection.body.ws, "open");
    assert.equal(outsideHits, 0);
    const previewId = await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as WebContentsView;
      return view.webContents.id;
    });
    await page.getByRole("button", { name: "收起代码工作区" }).click();
    await waitForView(app, false);
    await page.getByRole("button", { name: "展开代码工作区" }).click();
    await waitForView(app, true);
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => {
        const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as WebContentsView;
        return view.webContents.id;
      }),
      previewId,
    );
    await page.getByRole("button", { name: "project 项目操作" }).click();
    await page.getByRole("menu", { name: "project 项目操作" }).waitFor();
    await waitForView(app, false);
    await page.keyboard.press("Escape");
    await waitForView(app, true);
    await page.getByRole("button", { name: "访问权限" }).click();
    await page.getByRole("menuitemradio", { name: "请求批准" }).waitFor();
    await waitForView(app, false);
    await page.keyboard.press("Escape");
    await waitForView(app, true);
    await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
    await page.getByRole("dialog", { name: "新建项目" }).waitFor();
    await waitForView(app, false);
    await page.getByRole("button", { name: "关闭弹窗" }).click();
    await waitForView(app, true);
    await page.getByRole("button", { name: "打开设置" }).click();
    await waitForView(app, false);
    await page.getByRole("button", { name: "返回工作台", exact: true }).click();
    await waitForView(app, true);
    await page.getByRole("tab", { name: "file.ts", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="文件内容"]') !== null);
    await waitForView(app, false);
    await page.getByRole("tab", { name: "网页预览", exact: true }).click();
    await waitForView(app, true);
    await page.getByRole("button", { name: "关闭网页预览" }).click();
    await page.waitForFunction(
      () => document.querySelector('[aria-label="网页预览地址"]') === null,
    );
    await waitForView(app, null);
    await page.getByRole("button", { name: "预览 index.html" }).click();
    await page.getByText("项目文件：index.html").waitFor();
    await waitForView(app, true);
    const staticContent = await app.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as WebContentsView;
      return view.webContents.executeJavaScript(
        `new Promise(resolve => { const check = () => document.body?.dataset.loaded ? resolve({text: document.body.innerText, bridge: typeof window.desktop}) : setTimeout(check, 20); check(); })`,
      );
    });
    assert.deepEqual(staticContent, { text: "项目页面", bridge: "undefined" });
    await page.getByRole("tab", { name: "file.ts", exact: true }).click();
    await waitForView(app, false);
    await page.getByRole("button", { name: "关闭网页预览" }).click();
    await waitForView(app, null);
    await page.getByRole("button", { name: "预览 index.html" }).click();
    await waitForView(app, true);
    await page.getByRole("button", { name: "返回项目主页", exact: true }).click();
    await waitForView(app, null);
    await page.locator(".conversation-title").first().click();
    await page.getByRole("tab", { name: "file.ts", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "关闭网页预览" }).count(), 0);
  } finally {
    await app?.close();
    server.close();
    outside.close();
    await rm(root, { recursive: true, force: true });
  }
});
