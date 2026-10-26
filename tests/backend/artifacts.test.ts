import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { artifactDirectory, copyResource, localFile } from "../../src/backend/artifacts/files.ts";

test("artifact IO refuses links and escapes, streams bounded resources and verifies their hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-artifact-files-"));
  try {
    const project = join(root, "project");
    const outside = join(root, "outside");
    await mkdir(project);
    await mkdir(outside);
    await symlink(
      outside,
      join(project, ".daidai"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(artifactDirectory(project), /目录不可用/);
    await rm(join(project, ".daidai"));
    const artifacts = await artifactDirectory(project);
    const source = join(outside, "source.glb");
    const content = Buffer.alloc(2 * 1024 * 1024, 7);
    await writeFile(source, content);
    await assert.rejects(localFile(artifacts, source), /授权目录/);
    await symlink(source, join(artifacts, "linked.glb"));
    await assert.rejects(localFile(artifacts, join(artifacts, "linked.glb")), /符号链接/);
    const descriptor = {
      uri: pathToFileURL(source).href,
      mediaType: "model/gltf-binary",
      byteLength: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    const destination = join(artifacts, "copied.glb");
    await copyResource(
      await localFile(outside, source, content.length),
      destination,
      descriptor,
      new AbortController().signal,
    );
    assert.deepEqual(await readFile(destination), content);
    await assert.rejects(
      copyResource(
        source,
        join(artifacts, "bad.glb"),
        { ...descriptor, sha256: "0".repeat(64) },
        new AbortController().signal,
      ),
      /哈希/,
    );
    await assert.rejects(
      copyResource(
        source,
        join(artifacts, "oversize.glb"),
        { ...descriptor, byteLength: content.length - 1 },
        new AbortController().signal,
      ),
      /大小/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      copyResource(source, join(artifacts, "cancelled.glb"), descriptor, controller.signal),
      { name: "AbortError" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
