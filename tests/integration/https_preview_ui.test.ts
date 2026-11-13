import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WebContentsView } from "electron";
import { type ElectronApplication, _electron as electron } from "playwright";
import { chooseProject } from "./support.ts";

test("HTTPS 页面允许安全跳转、跨来源资源和 WSS，保持隔离并拒绝无效证书", {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-https-preview-"));
  const project = join(root, "project");
  await mkdir(project);
  const key = join(root, "key.pem");
  const cert = join(root, "cert.pem");
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
    ],
    { stdio: "ignore" },
  );
  const certificate = await readFile(cert, "utf8");
  const tls = { key: await readFile(key), cert: certificate };
  let httpHits = 0;
  const http = createHttpServer((_request, response) => {
    httpHits++;
    response.end("downgrade");
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const httpAddress = http.address();
  assert.ok(httpAddress && typeof httpAddress !== "string");
  let assetPort = 0;
  let pagePort = 0;
  const assets = createServer(tls, (request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: `https://127.0.0.1:${pagePort}/page` }).end();
    } else if (request.url === "/script.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end("document.body.dataset.asset = 'loaded';");
    } else response.end("asset");
  });
  assets.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("error", () => {});
  });
  assets.listen(0, "127.0.0.1");
  await once(assets, "listening");
  const assetAddress = assets.address();
  assert.ok(assetAddress && typeof assetAddress !== "string");
  assetPort = assetAddress.port;
  const pageServer = createServer(tls, (request, response) => {
    if (request.url === "/start") {
      response.writeHead(302, { Location: `https://127.0.0.1:${assetPort}/redirect` }).end();
    } else if (request.url === "/downgrade") {
      response.writeHead(302, { Location: `http://127.0.0.1:${httpAddress.port}/` }).end();
    } else {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<h1>HTTPS 页面</h1><a href="/next">下一页</a><script src="https://127.0.0.1:${assetPort}/script.js"></script><script>
        document.body.dataset.bridge = typeof window.desktop;
        document.body.dataset.node = typeof require;
        const socket = new WebSocket('wss://127.0.0.1:${assetPort}/socket');
        socket.onopen = () => document.body.dataset.ws = 'open';
        fetch('http://127.0.0.1:${httpAddress.port}/').catch(() => document.body.dataset.http = 'blocked');
        navigator.geolocation.getCurrentPosition(() => document.body.dataset.permission = 'allowed', () => document.body.dataset.permission = 'denied');
      </script>`);
    }
  });
  pageServer.listen(0, "127.0.0.1");
  await once(pageServer, "listening");
  const pageAddress = pageServer.address();
  assert.ok(pageAddress && typeof pageAddress !== "string");
  pagePort = pageAddress.port;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  let app: ElectronApplication | undefined;
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
    await page.getByRole("button", { name: "＋ 网页预览" }).click();
    const address = page.getByRole("textbox", { name: "网页预览地址" });
    await address.fill(`https://127.0.0.1:${pageAddress.port}/page`);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    // 先验证生产默认行为：自签名证书失败，没有全局忽略证书错误的配置。
    await page.getByRole("alert").filter({ hasText: "页面加载失败" }).waitFor();
    // 仅测试进程信任本次生成的确切证书；不修改产品的 TLS 策略。
    await app.evaluate(({ app }, certificate) => {
      app.on("certificate-error", (event, _contents, url, _error, presented, callback) => {
        if (new URL(url).hostname === "127.0.0.1" && presented.data.trim() === certificate.trim()) {
          event.preventDefault();
          callback(true);
        } else callback(false);
      });
    }, certificate);
    await address.fill(`https://127.0.0.1:${pageAddress.port}/start`);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector(".web-preview-status")?.textContent?.includes("/page"),
    );
    const inspection = await app.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as WebContentsView;
      return view.webContents.executeJavaScript(`new Promise(resolve => {
        const check = () => {
          const data = document.body?.dataset;
          if (data?.asset && data.ws && data.http && data.permission) resolve({...data});
          else setTimeout(check, 20);
        }; check();
      })`);
    });
    assert.deepEqual(inspection, {
      bridge: "undefined",
      node: "undefined",
      asset: "loaded",
      ws: "open",
      http: "blocked",
      permission: "denied",
    });
    assert.equal(httpHits, 0);
    await page.waitForFunction(() => {
      const status = document.querySelector(".web-preview-status")?.textContent ?? "";
      return status.includes("/page") && !status.includes("加载中");
    });
    await app.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as WebContentsView;
      await view.webContents.executeJavaScript("document.querySelector('a').click()", true);
    });
    await page.waitForFunction(() =>
      document.querySelector(".web-preview-status")?.textContent?.includes("/next"),
    );
    await page.getByRole("button", { name: "预览后退" }).click();
    await page.waitForFunction(() =>
      document.querySelector(".web-preview-status")?.textContent?.includes("/page"),
    );
    await page.getByRole("button", { name: "预览前进" }).click();
    await page.waitForFunction(() =>
      document.querySelector(".web-preview-status")?.textContent?.includes("/next"),
    );
    // HTTPS 重定向不能降级到本机 HTTP 服务。
    await address.fill(`https://127.0.0.1:${pageAddress.port}/downgrade`);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(httpHits, 0);
    await page.getByRole("button", { name: "关闭网页预览" }).click();
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.contentView.children.length,
      ),
      0,
    );
  } finally {
    await app?.close();
    for (const server of [http, assets, pageServer]) {
      server.closeAllConnections();
      server.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});
