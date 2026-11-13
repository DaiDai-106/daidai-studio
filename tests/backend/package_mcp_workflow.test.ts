import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openApplication } from "../../src/backend/application.ts";
import type { ApplicationEvent } from "../../src/contracts/application.ts";

test("Pi package registers an MCP server while standalone mcp.json files are ignored", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-package-mcp-"));
  const cwd = join(root, "work");
  const pkg = join(root, "package");
  const data = join(root, "data");
  const server = join(pkg, "server.mjs");
  const closed = join(root, "server-closed");
  const forbidden = join(root, "forbidden");
  const originalFetch = globalThis.fetch;
  let onEvent: (event: ApplicationEvent) => void = () => {};
  let app: Awaited<ReturnType<typeof openApplication>> | undefined;
  try {
    await mkdir(join(pkg, "extensions"), { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(join(data, "pi"), { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "mcp-package-fixture" }));
    await writeFile(
      server,
      `import readline from 'node:readline'; import {writeFileSync} from 'node:fs';
const rl=readline.createInterface({input:process.stdin});
function shutdown(){writeFileSync(${JSON.stringify(closed)}, 'closed'); process.exit(0)}
process.on('SIGTERM',shutdown); process.stdin.on('end',shutdown);
rl.on('line', line => { const req=JSON.parse(line); if(req.id === undefined) return;
let result; if(req.method==='initialize') result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
else if(req.method==='tools/list') result={tools:[{name:'echo',description:'Echo a value',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}]};
else if(req.method==='tools/call') result={content:[{type:'text',text:'echo:'+req.params.arguments.value}]};
else result={}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n'); });`,
    );
    await writeFile(
      join(pkg, "extensions", "index.ts"),
      `export default pi => pi.registerMcpServer('fixture', {command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(server)}],exposure:'direct'});`,
    );
    const rogue = {
      mcpServers: {
        forbidden: {
          command: process.execPath,
          args: ["-e", `require('fs').writeFileSync(${JSON.stringify(forbidden)},'started')`],
        },
      },
    };
    await writeFile(join(cwd, ".pi", "mcp.json"), JSON.stringify(rogue));
    await writeFile(join(data, "pi", "mcp.json"), JSON.stringify(rogue));
    app = await openApplication({
      dataRoot: data,

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
      path: cwd,
      mode: "coding",
    });
    await app.request("package.install", { source: pkg, scope: "project", projectId: project.id });
    const chat = await app.request("conversation.create", { projectId: project.id });
    let calls = 0;
    let declaredTools: string[] = [];
    globalThis.fetch = async (_input, init) => {
      calls++;
      const request = JSON.parse(String(init?.body)) as {
        tools?: { function?: { name?: string } }[];
      };
      if (calls === 1)
        declaredTools = (request.tools ?? []).map((tool) => tool.function?.name ?? "");
      const delta =
        calls === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "call_echo",
                  type: "function",
                  function: { name: "mcp__fixture__echo", arguments: '{"value":"hello"}' },
                },
              ],
            }
          : { role: "assistant", content: "done" };
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
          choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? "tool_calls" : "stop" }],
        },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const finished = new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error("MCP 对话未结束")), 20_000);
      onEvent = (event) => {
        if (
          event.type === "conversation" &&
          event.view.conversationId === chat.id &&
          !event.view.busy
        ) {
          clearTimeout(timeout);
          done();
        }
      };
    });
    await app.request("conversation.send", {
      id: chat.id,
      requestId: "mcp-request",
      text: "使用包工具",
    });
    await finished;
    assert.ok(declaredTools.includes("mcp__fixture__echo"));
    const view = await app.request("conversation.watch", { id: chat.id });
    assert.ok(
      view.messages.some(
        (message) => message.role === "tool" && message.text === "echo:hello" && !message.failed,
      ),
    );
    await assert.rejects(readFile(forbidden), { code: "ENOENT" });
    await app.close();
    app = undefined;
    assert.equal(await readFile(closed, "utf8"), "closed");
  } finally {
    if (app) await app.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
