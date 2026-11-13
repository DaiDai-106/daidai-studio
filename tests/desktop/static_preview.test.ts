import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStaticPreview } from "../../src/desktop/main/browser/static_server.ts";

test("项目静态预览限制资源路径并提供相对资源", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-static-preview-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "index.html"), '<script src="app.js"></script>');
  await writeFile(join(project, "app.js"), "window.test = true;");
  await writeFile(join(project, ".env"), "secret");
  await writeFile(join(root, "outside.txt"), "outside");
  await symlink(join(root, "outside.txt"), join(project, "escape.txt"));
  await symlink(root, join(project, "outside"));
  const preview = await createStaticPreview(project, "index.html");
  try {
    const page = await fetch(preview.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /object-src 'none'/);
    assert.equal(await (await fetch(new URL("app.js", preview.url))).text(), "window.test = true;");
    assert.equal((await fetch(new URL(".env", preview.url))).status, 404);
    assert.equal((await fetch(new URL("escape.txt", preview.url))).status, 404);
    assert.equal((await fetch(new URL("outside/outside.txt", preview.url))).status, 404);
    assert.equal((await fetch(new URL("%2e%2e/outside.txt", preview.url))).status, 404);
    assert.equal((await fetch(preview.url, { method: "POST" })).status, 405);
    await assert.rejects(createStaticPreview(project, ".env"));
  } finally {
    preview.close();
    await rm(root, { recursive: true, force: true });
  }
});
