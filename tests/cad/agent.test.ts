import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import type { CadHandle } from "../../resources/mcp/cad/contract.ts";
import { openRuntime } from "../../src/backend/runtime.ts";
import { planCadImport, selectedStepPath } from "../support/cadPlan.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

const executable = process.env.DAI_CAD_TEST_WORKER;
const fixture = process.env.DAI_CAD_TEST_FIXTURE;

test("Harness offers only CAD tools in scene mode and executes explicit native document calls", {
  skip: !executable || !fixture,
  timeout: 30_000,
}, async () => {
  assert.ok(executable && fixture);
  const root = await mkdtemp(join(tmpdir(), "dai-cad-agent-"));
  const path = join(root, "项目");
  await mkdir(path);
  const step = join(path, "机械 模型.STEP");
  await promisify(execFile)(fixture, ["--write-fixture", step]);
  const planner = await servePlanner((request) => {
    const user = request.messages.filter((message) => message.role === "user").at(-1)?.content;
    const names = request.tools?.map((tool) => tool.function.name) ?? [];
    if (user === "普通问候") {
      assert.deepEqual(names, []);
      assert.equal(JSON.stringify(request).includes(path), false);
      return { text: "你好。" };
    }
    if (user === "停用 CAD 后讨论") {
      assert.deepEqual(names, []);
      return { text: "可以继续讨论。" };
    }
    assert.equal(names.length, 12);
    assert.ok(names.every((name) => name.startsWith("cad_")));
    assert.equal(selectedStepPath(request), step);
    const results = turnResults(request);
    if (!results.has("caps")) return { id: "caps", name: "cad_get_capabilities", args: {} };
    const planned = planCadImport(request);
    if (planned) return planned;
    const imported = results.read<{
      data: { result: { document: CadHandle; objectCount: number } };
    }>("cad-import-wait").data;
    assert.equal(imported.result.objectCount, 4);
    if (!results.has("structure"))
      return {
        id: "structure",
        name: "cad_get_structure",
        args: { document: imported.result.document, mode: "all" },
      };
    const objects = results.read<{ data: { items: { name: string }[] } }>("structure").data.items;
    assert.equal(objects.length, 4);
    assert.ok(objects.some((object) => object.name === "first box"));
    assert.equal(
      results.read<{ data: { result: { summary: { complete: boolean } } } }>("cad-display-wait")
        .data.result.summary.complete,
      true,
    );
    return { text: "CAD 已导入，显示资源已生成。" };
  });
  const app = await openRuntime(
    root,
    { available: false, read: async () => "{}", write: async () => {} },
    () => {},
    { nativeDirectory: dirname(executable), skillsRoot: resolve("resources/skills") },
  );
  async function send(id: string, text: string) {
    await app.request("conversation.send", { id, requestId: crypto.randomUUID(), text });
    for (let index = 0; index < 1000; index++) {
      if (!(await app.request("workspace.get", {})).busyConversationId) return;
      await setTimeout(10);
    }
    assert.fail("Harness did not become idle");
  }
  try {
    await app.request("provider.save", {
      config: {
        id: "local",
        name: "Local planner",
        providerType: "local",
        authMethod: "none",
        endpoint: planner.endpoint,
        enabled: true,
        persistCredentials: false,
        models: [
          { id: "workflow-test", name: "Test", context: 128000, output: 1024, reasoning: "标准" },
        ],
      },
    });
    const project = await app.request("project.open", { path });
    const id = (await app.request("conversation.create", { projectId: project.id })).id;
    await send(id, "普通问候");
    await app.request("conversation.update", { id, mode: "scene" });
    await app.request("conversation.selectStep", { id, relativePath: "机械 模型.STEP" });
    await send(id, "导入选中的 STEP");
    assert.deepEqual(planner.failures, []);
    const view = await app.request("conversation.watch", { id });
    assert.equal(view.messages.at(-1)?.text, "CAD 已导入，显示资源已生成。");
    assert.equal(view.messages.filter((message) => message.role === "tool").length, 6);
    assert.ok(view.messages.every((message) => !message.failed));
    assert.deepEqual(
      await readdir(join(root, "tmp")),
      [],
      "Run completion releases native documents and temporary resources",
    );
    assert.equal((await app.request("workspace.get", {})).builtins.servers.length, 1);
    await app.request("capability.setEnabled", { id: "builtin.cad", enabled: false });
    await send(id, "停用 CAD 后讨论");
    assert.deepEqual(planner.failures, []);
    assert.equal(
      (await app.request("conversation.watch", { id })).messages.at(-1)?.text,
      "可以继续讨论。",
    );
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
