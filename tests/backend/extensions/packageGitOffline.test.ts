import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

test("Pi Git 安装和更新使用本地仓库，隔离作用域且失败不写入配置", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-git-package-"));
  const config = join(root, "gitconfig");
  const prefix = pathToFileURL(`${join(root, "git")}/`).href;
  await writeFile(config, `[url "${prefix}"]\n  insteadOf = https://example.invalid/\n`);
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve("tests/backend/extensions/fixtures/package-git-check.ts"),
        root,
      ],
      {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: config,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_ALLOW_PROTOCOL: "file",
          GIT_TERMINAL_PROMPT: "0",
          PI_OFFLINE: "0",
          npm_config_offline: "true",
          npm_config_cache: join(root, "npm-cache"),
        },
        timeout: 55_000,
      },
    );
    assert.equal(await readFile(join(root, "git-case-passed"), "utf8"), "verified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
