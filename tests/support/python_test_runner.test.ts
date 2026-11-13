import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("scene Python runner fails for an empty or entirely skipped suite", async (context) => {
  const python = process.env.DAI_SCENE_TEST_PYTHON ?? "python3";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") {
    context.skip("没有 Python，不能验证 Python 测试运行器。");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);
  const root = await mkdtemp(join(tmpdir(), "dai-python-runner-"));
  try {
    const run = () =>
      spawnSync(
        python,
        [resolve("tests/runners/test_scene_python.py"), "--start-directory", root],
        {
          encoding: "utf8",
        },
      );
    const empty = run();
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /没有发现 Python 测试/);
    await writeFile(
      join(root, "test_only_skip.py"),
      "import unittest\n@unittest.skip('fixture')\nclass Skipped(unittest.TestCase):\n def test_skip(self): pass\n",
    );
    const skipped = run();
    assert.equal(skipped.status, 1);
    assert.match(skipped.stderr, /未实际执行/);
    await writeFile(
      join(root, "test_only_skip.py"),
      "import unittest\nclass Expected(unittest.TestCase):\n @unittest.expectedFailure\n def test_expected(self): self.fail('fixture')\n",
    );
    const expectedFailure = run();
    assert.equal(expectedFailure.status, 1);
    assert.match(expectedFailure.stdout, /预期失败：1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
