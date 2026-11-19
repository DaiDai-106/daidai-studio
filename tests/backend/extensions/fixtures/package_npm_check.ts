import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCatalogService } from "../../../../src/backend/extensions/catalog_service.ts";
import { createPackageService } from "../../../../src/backend/extensions/package_service.ts";
import { waitForCatalogTask } from "../../../support/catalog_task.ts";

const root = process.argv[2];
const registry = process.argv[3];
if (!root || !registry) throw new Error("missing fixture options");
const dataRoot = join(root, "data");
const source = "npm:dai-offline-fixture";
const a = createPackageService({ dataRoot, moduleId: "coding" });
const b = createPackageService({ dataRoot, moduleId: "scene" });
async function extensionText(service: typeof a) {
  const extension = (await service.resolve()).extensions[0];
  assert.ok(extension);
  return readFile(extension.path, "utf8");
}
await a.install(source, "module");
assert.ok(
  (await a.inspect())[0]?.installedPath.startsWith(
    join(dataRoot, "agent/packages/modules/coding/.pi/npm"),
  ),
  "模块安装直接使用 coding/.pi/npm，不再创建 workspace",
);
assert.equal((await a.inspect()).length, 1);
assert.deepEqual(await b.inspect(), []);
assert.match(await extensionText(a), /version-1/);
await b.install(source, "global");
assert.equal((await b.inspect())[0]?.scope, "global");
assert.match(await extensionText(b), /version-1/);
const upgradeRoot = join(root, "upgrade");
const fixed = createPackageService({ dataRoot: upgradeRoot, moduleId: "coding" });
const oldSource = "npm:dai-offline-fixture@1.0.0";
await fixed.install(oldSource, "module");
await fixed.install(oldSource, "global");
await fixed.setEnabled(oldSource, "module", false);
await mkdir(join(upgradeRoot, "catalog"), { recursive: true });
await writeFile(
  join(upgradeRoot, "catalog", "origins.json"),
  JSON.stringify([
    {
      source: oldSource,
      host: "pi",
      scope: "module",
      moduleId: "coding",
      sourceId: "pi",
      entryId: "dai-offline-fixture",
    },
  ]),
);
const response = await fetch(`${registry}/switch-2`);
assert.equal(response.status, 204);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) =>
  String(input).startsWith("https://registry.npmjs.org/")
    ? Response.json({
        name: "dai-offline-fixture",
        version: "2.0.0",
        keywords: ["pi-package"],
        pi: { extensions: ["extensions/index.ts"] },
      })
    : originalFetch(input, init);
const catalog = createCatalogService({ dataRoot: upgradeRoot, publish() {}, async changed() {} });
try {
  const pinned = catalog.start({
    action: "update",
    source: oldSource,
    scope: "module",
    moduleId: "coding",
  });
  assert.match(
    (await waitForCatalogTask(async () => catalog.taskList(), pinned.id)).message,
    /固定在指定版本/,
  );
  await assert.rejects(
    catalog.install({
      sourceId: "pi",
      id: "dai-offline-fixture",
      version: "2.0.0",
      scope: "global",
      replaceSource: oldSource,
    }),
    /原插件或市场来源已变化/,
  );
  await assert.rejects(
    catalog.install({
      sourceId: "pi",
      id: "dai-offline-fixture",
      version: "3.0.0",
      scope: "module",
      moduleId: "coding",
      replaceSource: oldSource,
    }),
    /不可用/,
  );
  assert.equal((await fixed.inspect()).find((p) => p.scope === "module")?.version, "1.0.0");
  const task = await catalog.install({
    sourceId: "pi",
    id: "dai-offline-fixture",
    version: "2.0.0",
    scope: "module",
    moduleId: "coding",
    replaceSource: oldSource,
  });
  const result = await waitForCatalogTask(async () => catalog.taskList(), task.id);
  assert.equal(result.state, "completed", result.message);
  assert.match(result.message, /1\.0\.0 → 2\.0\.0/);
  const installed = await catalog.installed("coding");
  assert.equal(installed.find((p) => p.scope === "module")?.version, "2.0.0");
  assert.equal(installed.find((p) => p.scope === "module")?.enabled, false);
  assert.equal(installed.find((p) => p.scope === "module")?.sourceId, "pi");
  assert.equal(installed.find((p) => p.scope === "global")?.version, "1.0.0");
} finally {
  globalThis.fetch = originalFetch;
  await catalog.close();
}
await b.update(source);
assert.match(await extensionText(b), /version-2/, "global npm update must fetch the new version");
assert.match(
  await extensionText(a),
  /version-1/,
  "updating global scope must not modify module copy",
);
await a.update(source);
assert.match(await extensionText(a), /version-2/, "module npm package must update when selected");
const beforeFailedUpdate = await b.inspect();
assert.equal((await fetch(`${registry}/make-unavailable`)).status, 204);
await assert.rejects(b.update(source));
assert.deepEqual(await b.inspect(), beforeFailedUpdate);
assert.match(await extensionText(b), /version-2/);
const before = await a.inspect();
await assert.rejects(a.install("npm:dai-fixture-missing", "module"));
assert.deepEqual(await a.inspect(), before);

assert.equal((await fetch(`${registry}/desktop`)).status, 204);
let agentChanges = 0;
const desktop = createPackageService({
  dataRoot,
  host: "desktop",
  async beforeAgentChange() {
    agentChanges++;
    throw new Error("Agent busy");
  },
});
const theme = "npm:dai-offline-fixture@3.0.0";
await desktop.install(theme, "global");
// 同一数据根、同一个 npm 包名，两类宿主仍拥有各自的安装副本。
assert.equal((await desktop.inspect())[0]?.version, "3.0.0");
assert.match(await extensionText(a), /version-2/);
assert.match(await extensionText(b), /version-2/);
await desktop.update(theme);
await desktop.setEnabled(theme, "global", false);
await desktop.setEnabled(theme, "global", true);
await desktop.remove(theme, "global");
assert.equal(agentChanges, 0);
assert.match(await extensionText(a), /version-2/);
assert.match(await extensionText(b), /version-2/);
// 市场提示不能替代实际清单校验，Pi 包不能被注册到 Desktop 空间。
await assert.rejects(desktop.install("npm:dai-offline-fixture@2.0.0", "global"), /宿主不匹配/);
assert.deepEqual(await desktop.inspect(), []);
assert.equal(agentChanges, 0);
await writeFile(join(root, "npm-case-passed"), "verified");
