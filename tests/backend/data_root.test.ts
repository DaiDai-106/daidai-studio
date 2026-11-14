import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";

test("应用启动校验数据根身份", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-root-identity-"));
  const dataRoot = join(root, "data");
  await mkdir(dataRoot);
  try {
    const info = await stat(dataRoot, { bigint: true });
    const expectedRoot = { dev: info.dev.toString(), ino: info.ino.toString() };
    const app = await openApplication({ dataRoot, expectedRoot, publish: () => {} });
    await app.close();
    await assert.rejects(
      openApplication({ dataRoot, expectedRoot: { ...expectedRoot, ino: "0" }, publish: () => {} }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
