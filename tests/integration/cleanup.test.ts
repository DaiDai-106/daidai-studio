import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { cadInputs } from "../../resources/mcp/cad/contract.ts";
import { openRuntime } from "../../src/backend/runtime.ts";
import { commands, validateRequest } from "../../src/shared/application.ts";

test("cleanup removes editing APIs and native targets while retaining every CAD tool", async () => {
  for (const name of ["modeling", "assembly", "common"])
    await assert.rejects(access(resolve("resources/mcp", name)), { code: "ENOENT" });
  await assert.rejects(access(resolve("src/backend/scene")), { code: "ENOENT" });
  const cmake = await readFile(resolve("resources/mcp/CMakeLists.txt"), "utf8");
  assert.match(cmake, /add_subdirectory\(cad\)/);
  assert.doesNotMatch(cmake, /add_subdirectory\((modeling|assembly|common)\)/);
  assert.ok(Object.keys(commands).every((method) => !method.startsWith("scene.")));
  for (const method of ["scene.apply", "scene.export", "scene.restore", "scene.import"])
    assert.throws(() => validateRequest(method, {}), /不支持|无效|参数/);
  for (const id of ["builtin.modeling", "builtin.assembly"])
    assert.throws(() => validateRequest("capability.setEnabled", { id, enabled: true }));

  const root = await mkdtemp(join(tmpdir(), "dai-cleanup-"));
  const app = await openRuntime(
    root,
    { available: false, read: async () => "{}", write: async () => {} },
    () => {},
    {
      skillsRoot: resolve("resources/skills"),
    },
  );
  try {
    const workspace = await app.request("workspace.get", {});
    assert.deepEqual(
      workspace.builtins.servers.map((service) => service.id),
      ["builtin.cad"],
    );
    assert.deepEqual(
      workspace.builtins.servers[0]?.tools.map((tool) => tool.name),
      Object.keys(cadInputs),
    );
    assert.equal(workspace.builtins.servers[0]?.tools.length, 12);
    const skill = workspace.builtins.skills[0]?.body;
    assert.equal(typeof skill, "string");
    assert.ok(skill);
    assert.match(skill, /# STEP import/);
    assert.doesNotMatch(skill, /model_[a-z_]+|assembly_[a-z_]+|expectedRevision/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
