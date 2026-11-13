import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  allowedPreviewRequest,
  previewDisplayUrl,
  previewUrl,
} from "../../src/desktop/main/browser/urls.ts";

test("本地预览只允许回环 HTTP，拒绝凭据与其他主机", () => {
  const origin = previewUrl("http://localhost:5173/page?token=secret");
  assert.equal(origin.hostname, "127.0.0.1");
  assert.equal(previewDisplayUrl(origin.href), "http://127.0.0.1:5173/page");
  assert.equal(allowedPreviewRequest("http://127.0.0.1:5173/app.js", origin), true);
  assert.equal(allowedPreviewRequest("ws://127.0.0.1:5173/hmr", origin), true);
  assert.equal(allowedPreviewRequest("http://127.0.0.1:5174/", origin), false);
  assert.equal(allowedPreviewRequest("http://localhost:5173/", origin), false);
  assert.equal(allowedPreviewRequest("https://example.com/", origin), false);
  assert.equal(allowedPreviewRequest("file:///etc/passwd", origin), false);
  assert.throws(() => previewUrl("http://user:pass@localhost:5173/"));
  assert.throws(() => previewUrl("http://192.168.1.2:5173/"));
  assert.equal(previewUrl("https://example.com/").origin, "https://example.com");
  assert.throws(() => previewUrl("javascript:alert(1)"));
});

test("HTTPS 预览规范化域名，允许 HTTPS/WSS 资源并拒绝降级和特权协议", () => {
  const origin = previewUrl("google.com");
  assert.equal(origin.href, "https://google.com/");
  assert.equal(previewUrl("localhost:5173").href, "http://127.0.0.1:5173/");
  assert.equal(previewUrl("[::1]:5173").href, "http://[::1]:5173/");
  assert.equal(previewUrl("https://localhost/").hostname, "localhost");
  assert.equal(allowedPreviewRequest("https://www.google.com/search?q=test", origin, true), true);
  assert.equal(allowedPreviewRequest("https://www.gstatic.com/script.js", origin), true);
  assert.equal(allowedPreviewRequest("wss://example.com/socket", origin), true);
  assert.equal(allowedPreviewRequest("data:image/png;base64,AAAA", origin), true);
  for (const target of [
    "http://example.com/",
    "http://127.0.0.1/",
    "file:///tmp/index.html",
    "javascript:alert(1)",
    "https://user:pass@example.com/",
  ])
    assert.equal(allowedPreviewRequest(target, origin), false, target);
  for (const target of [
    "data:text/html,test",
    "blob:https://google.com/test",
    "wss://example.com/",
  ])
    assert.equal(allowedPreviewRequest(target, origin, true), false, target);
  for (const target of [
    "",
    "https:example.com",
    "file:///tmp/index.html",
    "https://user:pass@example.com",
    "https://example.com/\n",
    "data:text/html,test",
  ])
    assert.throws(() => previewUrl(target), target);
});
