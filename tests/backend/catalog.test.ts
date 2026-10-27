import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import type { CadManifest } from "../../resources/mcp/cad/contract.ts";
import { sceneFiles } from "../../src/backend/agent/scene.ts";
import { readObjectCatalog, writeObjectCatalog } from "../../src/backend/artifacts/catalog.ts";
import type { ImportedModel } from "../../src/shared/display.ts";

const transform = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
function manifest(count: number): CadManifest {
  return {
    schemaVersion: 2,
    source: {
      path: "/missing/assembly.step",
      sourceHash: "a".repeat(64),
      sourceLengthUnits: ["millimetre"],
      importFingerprint: "b".repeat(64),
    },
    roots: ["object-0"],
    displayToScene: transform,
    coordinateSystem: { unit: "m", upAxis: "Z", handedness: "right", gltfConversion: "x,z,-y" },
    quality: "preview",
    complete: true,
    resources: [],
    diagnostics: [],
    warnings: [],
    features: {
      resourceUri: "file:///features",
      objects: [
        { objectId: "object-1", startLine: 2, count: 3, analysisComplete: true, warnings: [] },
      ],
    },
    objects: Array.from({ length: count }, (_, i) => ({
      objectId: `object-${i}`,
      nodeKey: `object-${i}`,
      sourceKey: `/root/${i}`,
      ...(i ? { parentObjectId: "object-0" } : {}),
      name: `零件${i}`,
      kind: i ? "shape" : "assembly",
      localTransform: transform,
    })),
  };
}

test("compact catalogues contain every object and feature range, split at UTF-8/line limits without mutating saved data", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-catalog-"));
  try {
    const value = manifest(2500);
    const namedObject = value.objects[400];
    assert.ok(namedObject);
    namedObject.name = "较长的零件名称".repeat(120);
    const before = JSON.stringify(value);
    const catalogue = await writeObjectCatalog(root, value);
    assert.ok(catalogue.objects.length > 1);
    const firstPage = catalogue.objects[0];
    assert.ok(firstPage);
    let index = 0;
    const records = [];
    const read = createReadTool();
    // Text reads need only the environment; unexpected access to another API fails this fixture.
    const api = { env: new NodeExecutionEnv({ cwd: root }) } as unknown as Parameters<
      typeof read.execute
    >[1];
    for (const page of catalogue.objects) {
      const bytes = await readFile(page.path);
      assert.equal(page.byteLength, bytes.length);
      assert.ok(bytes.length <= 48 * 1024);
      const rows = bytes
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(rows.length <= 1000);
      assert.equal(page.startIndex, index);
      assert.equal(page.objectCount, rows.length);
      const result = await read.execute({ path: page.path }, api, context);
      assert.ok(
        result.output?.some(
          (block) => block.type === "text" && block.text === bytes.toString("utf8"),
        ),
        "Native Pi read returns the complete page",
      );
      assert.ok(!result.diagnostics?.some((item) => item.code === "truncated"));
      index += rows.length;
      records.push(...rows);
    }
    assert.equal(index, value.objects.length);
    assert.equal(new Set(records.map((item) => item.objectId)).size, value.objects.length);
    assert.equal(records[400].name, namedObject.name);
    assert.equal(records[2499].parentObjectId, "object-0");
    assert.ok(
      records.every(
        (item) => !Object.hasOwn(item, "localTransform") && !Object.hasOwn(item, "sourceKey"),
      ),
    );
    const references = (
      await Promise.all(catalogue.references.map((page) => readFile(page.path, "utf8")))
    )
      .join("")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(references[1].sourceKey, "/root/1");
    assert.equal(references[1].features.startLine, 2);
    assert.equal(references[1].features.count, 3);
    assert.equal(JSON.stringify(value), before);
    assert.deepEqual(await writeObjectCatalog(root, value), catalogue);
    await rm(firstPage.path);
    assert.deepEqual(
      await writeObjectCatalog(root, value),
      catalogue,
      "Missing derived pages are reproducible",
    );
    await writeFile(firstPage.path, "tampered");
    await assert.rejects(writeObjectCatalog(root, value), /不匹配|校验/);
    await rm(firstPage.path);
    const outside = join(root, "outside");
    await writeFile(outside, "untouched");
    await symlink(outside, firstPage.path);
    await assert.rejects(writeObjectCatalog(root, value), /符号链接/);
    assert.equal(await readFile(outside, "utf8"), "untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy saved manifests yield catalogues without STEP or metadata migrations; invalid/missing manifests remain errors", async () => {
  const project = await mkdtemp(join(tmpdir(), "dai-legacy-catalog-"));
  try {
    const value = manifest(2);
    const bytes = Buffer.from(JSON.stringify(value, null, 2));
    const hash = createHash("sha256").update(bytes).digest("hex");
    const model: ImportedModel = {
      importId: "c".repeat(64),
      projectId: "project",
      sourceId: "source",
      sourceHash: value.source.sourceHash,
      importFingerprint: value.source.importFingerprint,
      producerTaskId: "1",
      producerEntryId: "2",
      createdAt: "now",
      manifest: {
        id: hash,
        sha256: hash,
        url: "unused",
        mediaType: "application/json",
        byteLength: bytes.length,
      },
      resources: [],
      warnings: [],
    };
    const root = join(project, "artifacts", model.importId);
    await mkdir(root, { recursive: true });
    const path = join(root, "manifest.json");
    await writeFile(path, bytes);
    const catalogue = await readObjectCatalog(project, model);
    assert.equal(catalogue.objects.length, 1);
    assert.equal(catalogue.objectCount, 2);
    assert.ok((await readFile(path)).equals(bytes));
    // A page may disappear between finding an existing file and checking it.
    const fs = createRequire(import.meta.url)("node:fs/promises") as {
      lstat: typeof import("node:fs/promises").lstat;
    };
    const originalLstat = fs.lstat;
    const page = catalogue.objects[0];
    assert.ok(page);
    let pageRemoved = false;
    fs.lstat = (async (...args: unknown[]) => {
      if (!pageRemoved && args[0] === page.path) {
        pageRemoved = true;
        await rm(page.path);
      }
      return Reflect.apply(originalLstat, fs, args);
    }) as typeof fs.lstat;
    syncBuiltinESMExports();
    try {
      const files = await sceneFiles(model, project);
      assert.equal(pageRemoved, true);
      assert.equal(files?.catalogError?.code, "CATALOG_UNAVAILABLE");
      assert.ok((await readFile(path)).equals(bytes), "The manifest remains available");
    } finally {
      fs.lstat = originalLstat;
      syncBuiltinESMExports();
    }
    assert.equal(
      (await sceneFiles(model, project))?.catalogError,
      null,
      "A missing page can be rebuilt",
    );
    await assert.rejects(
      readObjectCatalog(project, { ...model, sourceHash: "d".repeat(64) }),
      /版本/,
    );
    // Matching bytes/hash must not let malformed cached data bypass the manifest validator.
    for (const [invalid, expected] of [
      [null, "显示清单结构无效。"],
      [{}, "显示清单结构无效。"],
      [{ source: { path: 42 } }, "显示清单结构无效。"],
      [{ ...value, source: { ...value.source, path: "" } }, "显示清单结构无效。"],
      [{ ...value, objects: null }, "显示清单结构无效。"],
      [{ ...value, complete: false }, "部分显示缺少明确的面排除记录，保留上次显示。"],
    ] as const) {
      const content = Buffer.from(JSON.stringify(invalid));
      const sha256 = createHash("sha256").update(content).digest("hex");
      await writeFile(path, content);
      const saved = {
        ...model,
        manifest: { ...model.manifest, byteLength: content.length, sha256 },
      };
      await assert.rejects(readObjectCatalog(project, saved), { message: expected });
      if (invalid && "objects" in invalid && invalid.objects === null) {
        const files = await sceneFiles(saved, project);
        assert.deepEqual(files?.catalogError, { code: "CATALOG_UNAVAILABLE", message: expected });
        assert.deepEqual(files?.objects, []);
      }
    }
    const changed = Buffer.from(bytes);
    changed[changed.indexOf("零件")] = 65;
    await writeFile(path, changed);
    await assert.rejects(readObjectCatalog(project, model), /校验/);
    await rm(path);
    await assert.rejects(readObjectCatalog(project, model), { code: "ENOENT" });
    assert.equal((await sceneFiles(model, project))?.catalogError?.code, "MANIFEST_MISSING");
    await rm(root, { recursive: true });
    assert.equal((await sceneFiles(model, project))?.catalogError?.code, "MANIFEST_MISSING");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
