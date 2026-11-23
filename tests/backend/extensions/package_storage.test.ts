import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../../src/backend/application.ts";
import { createPackageService } from "../../../src/backend/extensions/package_service.ts";

test("启动不搬迁或加载旧模块目录，当前插件安装和解析不受影响", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-package-storage-"));
  const dataRoot = join(root, "data");
  const moduleRoot = join(dataRoot, "agent/packages/modules/coding");
  const previous = join(moduleRoot, "workspace/.pi/extensions/old.ts");
  const current = join(moduleRoot, ".pi/marker");
  const source = join(root, "plugin");
  let app: Awaited<ReturnType<typeof openApplication>> | undefined;
  try {
    await mkdir(join(moduleRoot, "workspace/.pi/extensions"), { recursive: true });
    await writeFile(previous, "export default () => {};\n");
    await mkdir(join(moduleRoot, ".pi"));
    await writeFile(current, "current");
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "current-plugin",
        version: "1.0.0",
        pi: { extensions: ["index.ts"] },
      }),
    );
    await writeFile(join(source, "index.ts"), "export default () => {};\n");
    const packages = createPackageService({ dataRoot });
    await packages.install(source, "module");
    app = await openApplication({ dataRoot, publish() {} });
    assert.deepEqual(
      (await app.request("package.list", { moduleId: "coding" })).map((item) => item.source),
      [source],
    );
    assert.deepEqual(
      (await packages.resolve()).extensions.map((item) => item.path),
      [join(source, "index.ts")],
    );
    assert.equal(await readFile(previous, "utf8"), "export default () => {};\n");
    assert.equal(await readFile(current, "utf8"), "current");
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
