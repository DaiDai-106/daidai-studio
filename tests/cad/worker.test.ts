import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CadWorker } from "../../resources/mcp/cad/worker.ts";

const executable = process.env.DAI_CAD_TEST_WORKER;
test("an invalid native response rejects its own pending request and joins the worker", {
  skip: !executable,
  timeout: 5000,
}, async () => {
  assert.ok(executable);
  const root = await mkdtemp(join(tmpdir(), "dai-native-frame-"));
  const work = join(root, "work"),
    outputRoot = join(root, "outputs");
  await mkdir(outputRoot);
  const worker = await CadWorker.start({
    executable: join(
      dirname(executable),
      `cad-protocol-fixture${process.platform === "win32" ? ".exe" : ""}`,
    ),
    stagingRoot: work,
    outputRoot,
  });
  try {
    await assert.rejects(
      worker.request("cad_get_capabilities", {}),
      /violates the application contract/,
    );
    await Promise.all([worker.close(), worker.close()]);
    assert.deepEqual(await readdir(work), []);
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});
