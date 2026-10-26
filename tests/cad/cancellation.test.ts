import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { openRuntime } from "../../src/backend/runtime.ts";
import { selectedStepPath } from "../support/cadPlan.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

const executable = process.env.DAI_CAD_TEST_WORKER;
const fixture = process.env.DAI_CAD_TEST_FIXTURE;
const realStep = process.env.DAI_CAD_REAL_STEP;
test("stopping a real large STEP ToolTask joins its worker before allowing another project", {
  skip: !executable || !fixture || !realStep,
  timeout: 60_000,
}, async () => {
  assert.ok(executable && fixture && realStep);
  const root = await mkdtemp(join(tmpdir(), "dai-cad-stop-"));
  const before = await stat(realStep);
  const planner = await servePlanner((request) => {
    const results = turnResults(request);
    if (
      request.messages.filter((message) => message.role === "user").at(-1)?.content ===
      "查询 CAD 能力。"
    ) {
      return results.count
        ? { text: "CAD 已就绪。" }
        : { id: "caps", name: "cad_get_capabilities", args: {} };
    }
    return results.count === 0
      ? { id: "import", name: "cad_import_step", args: { path: selectedStepPath(request) } }
      : {
          id: "wait",
          name: "cad_wait_job",
          args: { job: results.read<{ data: { job: unknown } }>("import").data.job },
        };
  });
  let calculating = false;
  const app = await openRuntime(
    root,
    { available: false, read: async () => "{}", write: async () => {} },
    (event) => {
      if (
        event.type === "conversation" &&
        event.view.activeTools.some(
          (tool) =>
            tool.name === "cad_wait_job" &&
            ["read_step", "transfer_step", "build_structure"].includes(tool.phase),
        )
      )
        calculating = true;
    },
    { nativeDirectory: dirname(executable), skillsRoot: resolve("resources/skills") },
  );
  try {
    await app.request("provider.save", {
      config: {
        id: "stop",
        providerType: "local",
        name: "Stop fixture",
        authMethod: "none",
        endpoint: planner.endpoint,
        enabled: true,
        persistCredentials: false,
        models: [
          { id: "workflow-test", name: "Stop", context: 128000, output: 1024, reasoning: "标准" },
        ],
      },
    });
    const project = await app.request("project.open", { path: dirname(resolve(realStep)) });
    const conversation = await app.request("conversation.create", { projectId: project.id });
    const id = conversation.id;
    await app.request("conversation.update", { id, mode: "scene" });
    await app.request("conversation.selectStep", { id, relativePath: basename(realStep) });
    await app.request("conversation.watch", { id });
    await app.request("conversation.send", { id, requestId: "cancel", text: "解析选中的 STEP。" });
    for (let index = 0; index < 300 && !calculating; index++) await setTimeout(50);
    assert.equal(calculating, true, "wait for the actual native parse phase before cancelling");
    await app.request("conversation.stop", { id });
    assert.equal((await app.request("workspace.get", {})).busyConversationId, null);
    assert.deepEqual(
      await readdir(join(root, "tmp")),
      [],
      "no staging directory remains after cancellation returns",
    );
    assert.equal(
      planner.requests.length,
      2,
      "a stopped ToolTask must not request another model response",
    );
    const nextPath = join(root, "next");
    await mkdir(nextPath);
    await promisify(execFile)(fixture, ["--write-fixture", join(nextPath, "assembly.step")]);
    const nextProject = await app.request("project.open", { path: nextPath });
    const next = await app.request("conversation.create", { projectId: nextProject.id });
    await app.request("conversation.update", { id: next.id, mode: "scene" });
    await app.request("conversation.selectStep", { id: next.id, relativePath: "assembly.step" });
    await app.request("conversation.send", {
      id: next.id,
      requestId: "next-capabilities",
      text: "查询 CAD 能力。",
    });
    for (let index = 0; index < 500; index++) {
      if (!(await app.request("workspace.get", {})).busyConversationId) break;
      await setTimeout(10);
    }
    assert.equal((await app.request("workspace.get", {})).busyConversationId, null);
    const nextView = await app.request("conversation.watch", { id: next.id });
    assert.ok(nextView.messages.some((message) => message.role === "tool" && !message.failed));
    const after = await stat(realStep);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(planner.failures, []);
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
