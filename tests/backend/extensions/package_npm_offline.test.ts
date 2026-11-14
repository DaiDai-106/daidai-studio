import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createThemePackage } from "../../support/desktop_theme.ts";

const exec = promisify(execFile);
test("Pi npm 使用本地测试 registry 安装和更新，隔离作用域且失败不写配置", {
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-npm-package-"));
  const packages = new Map<string, { bytes: Buffer; sha: string }>();
  for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
    const build = join(root, `build-${version}`);
    const dir = join(build, "package");
    await mkdir(join(dir, "extensions"), { recursive: true });
    if (version === "3.0.0") await createThemePackage(dir);
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "dai-offline-fixture",
        version,
        ...(version === "3.0.0"
          ? { dai: JSON.parse(await readFile(join(dir, "package.json"), "utf8")).dai }
          : { pi: { extensions: ["extensions/index.ts"] } }),
      }),
    );
    await writeFile(
      join(dir, "extensions", "index.ts"),
      `// version-${version[0]}\nexport default () => {};\n`,
    );
    const archive = join(root, `${version}.tgz`);
    await exec("tar", ["-czf", archive, "-C", build, "package"]);
    const bytes = await readFile(archive);
    packages.set(version, { bytes, sha: createHash("sha1").update(bytes).digest("hex") });
  }
  let current = "1.0.0";
  let unavailable = false;
  let address = "";
  const server = createServer((req, res) => {
    if (req.url === "/switch-2") {
      current = "2.0.0";
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === "/make-unavailable") {
      unavailable = true;
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === "/desktop") {
      unavailable = false;
      current = "3.0.0";
      res.writeHead(204);
      res.end();
      return;
    }
    if (unavailable) {
      res.writeHead(503);
      res.end("unavailable");
      return;
    }
    if (req.url?.startsWith("/archive/")) {
      const version = req.url.slice("/archive/".length).replace(/\.tgz$/, "");
      const item = packages.get(version);
      if (item) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(item.bytes);
        return;
      }
    }
    if (req.url === "/dai-offline-fixture") {
      const versions = Object.fromEntries(
        [...packages].map(([version, item]) => [
          version,
          {
            name: "dai-offline-fixture",
            version,
            dist: { tarball: `${address}/archive/${version}.tgz`, shasum: item.sha },
          },
        ]),
      );
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({ name: "dai-offline-fixture", "dist-tags": { latest: current }, versions }),
      );
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("local registry failed to start");
    address = `http://127.0.0.1:${bound.port}`;
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (/proxy|token|auth|^npm_config_/i.test(key)) delete env[key];
    Object.assign(env, {
      PI_OFFLINE: "0",
      npm_config_registry: address,
      npm_config_cache: join(root, "cache"),
      npm_config_userconfig: join(root, "user.npmrc"),
      npm_config_globalconfig: join(root, "global.npmrc"),
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: "true",
      npm_config_fetch_retries: "0",
      npm_config_prefer_online: "true",
    });
    await exec(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve("tests/backend/extensions/fixtures/package_npm_check.ts"),
        root,
        address,
      ],
      { env, timeout: 80_000 },
    );
    assert.equal(await readFile(join(root, "npm-case-passed"), "utf8"), "verified");
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
