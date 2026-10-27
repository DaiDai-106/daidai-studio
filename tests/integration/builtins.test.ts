import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cadInputs } from "../../resources/mcp/cad/contract.ts";
import { loadBuiltins } from "../../src/backend/builtin.ts";

test("startup registers builtin metadata from the shared contract and actual skill file through live MCP discovery without launching geometry", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-builtins-"));
  const skillsRoot = join(root, "skills");
  await mkdir(join(skillsRoot, "scene-building"), { recursive: true });
  const body = "---\nname: scene-building\n---\n\nActual builtin instruction.";
  await writeFile(join(skillsRoot, "scene-building", "SKILL.md"), body);
  try {
    const builtins = await loadBuiltins(
      { cadExecutable: process.execPath, skillsRoot },
      join(root, "temporary"),
    );
    assert.equal(builtins.cad.available, true);
    assert.deepEqual(
      builtins.catalog.servers[0]?.tools.map((tool) => tool.name),
      Object.keys(cadInputs),
    );
    assert.equal(builtins.catalog.skills[0]?.body, body);
    assert.equal(builtins.skills.get("scene-building"), body);
    assert.deepEqual(
      await readdir(root),
      ["skills", "temporary"],
      "Only a temporary configuration root is created at discovery",
    );
    const unavailable = await loadBuiltins({ cadExecutable: root }, join(root, "temporary"));
    assert.equal(unavailable.cad.available, false);
    assert.equal(unavailable.catalog.servers[0]?.available, false);
    assert.ok(unavailable.catalog.skills[0]?.body);
    assert.equal(unavailable.catalog.skills[0]?.automatic, true);
    const missing = await loadBuiltins(
      { skillsRoot: join(root, "missing-skills") },
      join(root, "temporary"),
    );
    assert.equal(missing.catalog.skills[0]?.body, null);
    assert.equal(missing.skills.size, 0);
    await Promise.all([builtins.close(), unavailable.close(), missing.close()]);
    await writeFile(join(skillsRoot, "scene-building", "SKILL.md"), "x".repeat(64_001));
    await assert.rejects(loadBuiltins({ skillsRoot }, join(root, "temporary")), /超过大小/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
