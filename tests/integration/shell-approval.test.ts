import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openRuntime } from "../../src/backend/runtime.ts";
import { servePlanner, turnResults } from "../support/planner.ts";

const shellName = process.platform === "win32" ? "powershell" : "bash";
const command = `node -e "require('fs').writeFileSync('marker.txt','approved')"`;

test("scene shell waits for explicit approval, respects rejection and stop, and executes in the project", {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-shell-"));
  const slowCommand = `node -e "setTimeout(()=>require('fs').writeFileSync('marker.txt','late'),2000)"`;
  const planner = await servePlanner((request) => {
    const user = request.messages.filter((message) => message.role === "user").at(-1)?.content;
    return turnResults(request).count === 0
      ? {
          id: "shell-call",
          name: shellName,
          args: { command: user === "停止运行" ? slowCommand : command },
        }
      : { text: "Done" };
  });
  const vault = { available: false, read: async () => "{}", write: async () => {} };
  let app = await openRuntime(root, vault, () => {});
  const marker = join(root, "marker.txt");
  async function awaitApproval() {
    for (let i = 0; i < 500; i++) {
      const pending = (await app.request("workspace.get", {})).shellApproval;
      if (pending) return pending;
      await setTimeout(10);
    }
    assert.fail("Shell approval not requested");
  }
  async function waitIdle() {
    for (let i = 0; i < 500; i++) {
      if (!(await app.request("workspace.get", {})).busyConversationId) return;
      await setTimeout(10);
    }
    assert.fail("Shell run did not finish");
  }
  try {
    await app.request("provider.save", {
      config: {
        id: "local",
        name: "Test",
        providerType: "local",
        endpoint: planner.endpoint,
        enabled: true,
        authMethod: "none",
        persistCredentials: false,
        models: [
          { id: "workflow-test", name: "Test", context: 8192, output: 1024, reasoning: "标准" },
        ],
      },
    });
    const project = await app.request("project.open", { path: root });
    const id = (await app.request("conversation.create", { projectId: project.id })).id;
    await app.request("conversation.update", { id, mode: "scene", modelId: "local:workflow-test" });
    await app.request("conversation.send", { id, requestId: "reject", text: "检查" });
    const rejected = await awaitApproval();
    assert.equal(rejected.command, command);
    assert.equal(rejected.cwd, root);
    await assert.rejects(access(marker));
    await app.request("shell.respond", { id: rejected.id, approved: false });
    await waitIdle();
    await assert.rejects(access(marker));
    await assert.rejects(
      app.request("shell.respond", { id: rejected.id, approved: true }),
      /已失效/,
    );
    await app.request("conversation.send", { id, requestId: "stop", text: "再检查" });
    const stopped = await awaitApproval();
    await app.request("conversation.stop", { id });
    assert.equal((await app.request("workspace.get", {})).shellApproval, null);
    await assert.rejects(
      app.request("shell.respond", { id: stopped.id, approved: true }),
      /已失效/,
    );
    await assert.rejects(access(marker));
    await app.request("conversation.send", { id, requestId: "shutdown", text: "再次检查" });
    const interrupted = await awaitApproval();
    await app.close();
    await assert.rejects(access(marker));
    app = await openRuntime(root, vault, () => {});
    assert.equal((await app.request("workspace.get", {})).shellApproval, null);
    await assert.rejects(
      app.request("shell.respond", { id: interrupted.id, approved: true }),
      /已失效/,
    );
    await app.request("conversation.send", { id, requestId: "stop-running", text: "停止运行" });
    const running = await awaitApproval();
    await app.request("shell.respond", { id: running.id, approved: true });
    await setTimeout(100);
    await app.request("conversation.stop", { id });
    await setTimeout(2100);
    await assert.rejects(access(marker));
    await app.request("conversation.send", { id, requestId: "approve", text: "继续检查" });
    const accepted = await awaitApproval();
    await app.request("shell.respond", { id: accepted.id, approved: true });
    await waitIdle();
    assert.equal(await readFile(marker, "utf8"), "approved");
  } finally {
    await app.close();
    await planner.close();
    await rm(root, { recursive: true, force: true });
  }
});
