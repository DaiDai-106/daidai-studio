import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { openRuntime } from "../../src/backend/runtime.ts";
import type { ApplicationEvent } from "../../src/shared/application.ts";
import { planCadImport } from "../support/cadPlan.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

const executable = process.env.DAI_CAD_TEST_WORKER;
const fixture = process.env.DAI_CAD_TEST_FIXTURE;

test("a failed display handoff is shown as a failed tool and never publishes a display", {
  skip: !executable || !fixture,
  timeout: 30000,
}, async () => {
  assert.ok(executable && fixture);
  const root = await mkdtemp(join(tmpdir(), "dai-display-handoff-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  await promisify(execFile)(fixture, ["--write-fixture", join(projectPath, "assembly.step")]);
  const planner = await servePlanner((request) => {
    const results = turnResults(request);
    if (!results.has("cad-display-wait")) {
      const next = planCadImport(request);
      assert.ok(next);
      return next;
    }
    const result = request.messages.find((message) => message.tool_call_id === "cad-display-wait");
    assert.match(result?.content ?? "", /未能接管显示资源/);
    assert.match(result?.content ?? "", /"status":"succeeded"/);
    return { text: "显示接管失败。" };
  });
  const events: ApplicationEvent[] = [];
  const app = await openRuntime(
    root,
    { available: false, read: async () => "{}", write: async () => {} },
    (event) => events.push(event),
    { nativeDirectory: dirname(executable), skillsRoot: resolve("resources/skills") },
  );
  try {
    await app.request("provider.save", {
      config: {
        id: "local",
        name: "test",
        providerType: "local",
        authMethod: "none",
        enabled: true,
        persistCredentials: false,
        endpoint: planner.endpoint,
        models: [{ id: "test", name: "test", context: 128000, output: 2048, reasoning: "标准" }],
      },
    });
    const project = await app.request("project.open", { path: projectPath });
    const conversation = await app.request("conversation.create", { projectId: project.id });
    const id = conversation.id;
    await app.request("conversation.update", { id, mode: "scene" });
    await app.request("conversation.selectStep", { id, relativePath: "assembly.step" });

    // A regular file in place of the artifact directory causes a real handoff failure.
    await mkdir(join(root, "projects", project.id), { recursive: true });
    const blocked = join(root, "projects", project.id, "artifacts");
    await writeFile(blocked, "not a directory");
    await app.request("conversation.send", { id, requestId: "handoff-failure", text: "导入 STEP" });
    for (
      let attempt = 0;
      (await app.request("workspace.get", {})).busyConversationId && attempt < 500;
      attempt++
    )
      await setTimeout(20);
    assert.equal((await app.request("workspace.get", {})).busyConversationId, null);
    assert.deepEqual(planner.failures, []);

    const view = await app.request("conversation.watch", { id });
    const result = view.messages.find((message) => message.tool?.callId === "cad-display-wait");
    assert.ok(result, JSON.stringify(view.messages));
    assert.equal(result.outcome, "failed");
    assert.equal(result.failed, true);
    assert.match(result.text, /未能接管显示资源/);
    assert.match(result.text, /"status":"succeeded"/);
    assert.equal(await app.request("display.get", { id }), null);
    assert.equal(events.filter((event) => event.type === "display.changed").length, 0);
    assert.equal(await readFile(blocked, "utf8"), "not a directory");
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
