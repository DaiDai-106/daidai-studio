import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";

test("Pi 真实 read 工具拒绝目录遍历和外部符号链接，仍能读取项目文件", {
  skip: process.platform === "win32",
  timeout: 15_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-file-workflow-"));
  const cwd = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  await writeFile(join(cwd, "allowed.txt"), "allowed-content");
  await writeFile(join(outside, "secret.txt"), "secret-content");
  await symlink(outside, join(cwd, "escape"), "dir");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let body = "";
  let allowWriting = false;
  globalThis.fetch = async (_input, init) => {
    requests++;
    body = String(init?.body ?? "");
    const paths = ["../outside/secret.txt", "escape/secret.txt", "allowed.txt"];
    const total = paths.length + (allowWriting ? 1 : 0);
    const delta =
      allowWriting && requests === total
        ? {
            tool_calls: [
              {
                index: 0,
                id: `write-${requests}`,
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ path: "../outside/new.txt", content: "written" }),
                },
              },
            ],
          }
        : requests <= paths.length
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `read-${requests}`,
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({ path: paths[requests - 1] }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "完成" };
    const chunk = (value: object, reason: string | null) =>
      `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "example", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
    return new Response(
      `${chunk(delta, null)}${chunk({}, requests <= total ? "tool_calls" : "stop")}data: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  let finished!: () => void;
  let done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const app = await openApplication({
    dataRoot: join(root, "data"),

    publish: (event) => {
      if (event.type === "conversation" && !event.view.busy) finished();
    },
  });
  try {
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
      name: "项目",
      mode: "general",
      path: cwd,
    });
    const conversation = await app.request("conversation.create", { projectId: project.id });
    await app.request("conversation.send", {
      id: conversation.id,
      requestId: "request",
      text: "读取文件",
    });
    await done;
    const view = await app.request("conversation.watch", { id: conversation.id });
    assert.equal(view.error, "");
    assert.ok(body.includes("allowed-content"));
    assert.ok(!body.includes("secret-content"));
    assert.equal(
      view.messages.filter((message) => message.role === "tool" && message.failed).length,
      2,
    );
    await app.request("conversation.update", { id: conversation.id, accessMode: "full" });
    requests = 0;
    allowWriting = true;
    body = "";
    done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    await app.request("conversation.send", {
      id: conversation.id,
      requestId: "request-full",
      text: "再次读取文件",
    });
    await done;
    assert.ok(body.includes("secret-content"));
    assert.equal(await readFile(join(outside, "new.txt"), "utf8"), "written");
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
