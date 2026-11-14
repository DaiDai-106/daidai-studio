import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";
import type { ApplicationEvent, ShellApproval } from "../../src/contracts/application.ts";

test("Pi shell commands wait for approval and can be rejected or cancelled", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-shell-workflow-"));
  const marker = join(root, "executed.txt");
  const script = join(root, "write.cjs");
  const originalFetch = globalThis.fetch;
  let onEvent: (event: ApplicationEvent) => void = () => {};
  let app: Awaited<ReturnType<typeof openApplication>> | undefined;
  try {
    await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`);
    app = await openApplication({
      dataRoot: join(root, "data"),

      publish: (event) => onEvent(event),
    });
    await app.request("provider.save", {
      config: {
        id: "local",
        name: "Local",
        providerType: "local",
        authMethod: "none",
        endpoint: "http://127.0.0.1:11434/v1",
        enabled: true,

        models: [
          { id: "example", name: "Example", context: 4096, output: 1024, reasoning: "标准" },
        ],
      },
    });
    const project = await app.request("project.create", {
      name: "测试",
      path: root,
      mode: "coding",
    });
    const chat = await app.request("conversation.create", { projectId: project.id });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      const delta =
        calls % 2 === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${calls}`,
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
                    }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "结束" };
      const chunks = [
        {
          id: "reply",
          object: "chat.completion.chunk",
          created: 1,
          model: "example",
          choices: [{ index: 0, delta, finish_reason: null }],
        },
        {
          id: "reply",
          object: "chat.completion.chunk",
          created: 1,
          model: "example",
          choices: [
            { index: 0, delta: {}, finish_reason: calls % 2 === 1 ? "tool_calls" : "stop" },
          ],
        },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    async function run(decision: "reject" | "approve" | "cancel") {
      let resolveApproval!: (value: ShellApproval) => void;
      let resolveFinished!: () => void;
      const approved = new Promise<ShellApproval>((resolve) => {
        resolveApproval = resolve;
      });
      const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      onEvent = (event) => {
        if (event.type === "shell.approval" && event.approval) resolveApproval(event.approval);
        if (
          event.type === "conversation" &&
          event.view.conversationId === chat.id &&
          !event.view.busy
        )
          resolveFinished();
      };
      await app?.request("conversation.send", {
        id: chat.id,
        requestId: `request-${decision}`,
        text: "执行命令",
      });
      const request = await approved;
      assert.equal(request.conversationId, chat.id);
      assert.equal(request.cwd, root);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      if (decision === "cancel") await app?.request("conversation.stop", { id: chat.id });
      else
        await app?.request("shell.respond", { id: request.id, approved: decision === "approve" });
      await finished;
      if (decision === "approve") {
        assert.equal(await readFile(marker, "utf8"), "executed");
        await rm(marker);
      } else await assert.rejects(readFile(marker), { code: "ENOENT" });
    }
    await run("reject");
    await run("approve");
    await run("cancel");
    await app.request("conversation.update", { id: chat.id, accessMode: "full" });
    calls = 0;
    let approvalRequested = false;
    let finishFull!: () => void;
    const fullFinished = new Promise<void>((resolve) => {
      finishFull = resolve;
    });
    onEvent = (event) => {
      if (event.type === "shell.approval" && event.approval) approvalRequested = true;
      if (
        event.type === "conversation" &&
        event.view.conversationId === chat.id &&
        !event.view.busy
      )
        finishFull();
    };
    await app.request("conversation.send", {
      id: chat.id,
      requestId: "request-full",
      text: "执行命令",
    });
    await fullFinished;
    assert.equal(approvalRequested, false);
    assert.equal(await readFile(marker, "utf8"), "executed");
    assert.equal((await app.request("conversation.fork", { id: chat.id })).accessMode, "ask");
    await rm(marker);
    await app.request("conversation.update", { id: chat.id, accessMode: "ask" });
    calls = 0;
    await run("reject");
  } finally {
    if (app) await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
