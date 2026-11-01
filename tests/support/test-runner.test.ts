import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("test runner reports real pass, skip and failure counts and fails on empty discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dai-test-runner-"));
  const passing = join(directory, "passing.test.ts");
  const failing = join(directory, "failing.test.ts");
  const skippedOnly = join(directory, "skipped.test.ts");
  try {
    await writeFile(
      passing,
      'import { test } from "node:test";\ntest("passes", () => {});\ntest("skips", { skip: true }, () => {});\n',
    );
    await writeFile(
      failing,
      'import { test } from "node:test";\ntest("fails", () => { throw new Error("expected fixture failure"); });\n',
    );
    await writeFile(
      skippedOnly,
      'import { test } from "node:test";\ntest("skip", { skip: true }, () => {});\n',
    );
    const run = (...files: string[]) =>
      spawnSync(process.execPath, [resolve("tests/runners/test-runner.mjs"), ...files], {
        encoding: "utf8",
      });
    const passed = run(passing);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(
      passed.stdout,
      /# Overall test results\n# tests 2\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n/,
    );
    const failed = run(passing, failing);
    assert.equal(failed.status, 1);
    assert.match(
      failed.stdout,
      /# Overall test results\n# tests 3\n# pass 1\n# fail 1\n# cancelled 0\n# skipped 1\n/,
    );
    assert.match(failed.stdout, /expected fixture failure/);
    const empty = run(join(directory, "missing", "*.test.ts"));
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /No test files matched/);
    const skipped = run(skippedOnly);
    assert.equal(skipped.status, 1);
    assert.match(skipped.stderr, /No tests passed/);
    const current = run("--list");
    assert.equal(current.status, 0, current.stderr);
    assert.match(current.stdout, /tests\/backend\/application-workflow\.test\.ts/);
    assert.doesNotMatch(current.stdout, /tests\/integration\/backend-runtime\.test\.ts/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
