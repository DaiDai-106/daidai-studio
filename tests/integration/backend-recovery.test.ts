import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openRuntime } from "../../src/backend/runtime.ts";

test("crashed work is cancelled before scheduling, preserves history, and never replays a model request", {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-recovery-"));
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Read the SDK request. */
    }
    requests++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.flushHeaders();
    // Deliberately leave generation pending while the process is killed.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const child = fork(
    new URL("../fixtures/recovery-worker.ts", import.meta.url),
    [root, `http://127.0.0.1:${address.port}/v1`],
    { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;
  try {
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(10000) });
    const id = (message as { conversationId: string }).conversationId;
    for (let attempt = 0; !requests && attempt < 100; attempt++) await setTimeout(20);
    assert.equal(requests, 1);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    runtime = await openRuntime(
      root,
      {
        available: false,
        read: async () => "{}",
        write: async () => {
          throw new Error("Unexpected credential write");
        },
      },
      () => {},
    );
    const state = await runtime.request("workspace.get", {});
    assert.equal(state.busyConversationId, null);
    assert.equal(state.conversations[0]?.interrupted, true);
    const view = await runtime.request("conversation.watch", { id });
    assert.equal(view.busy, false);
    assert.ok(view.messages.some((message) => message.text === "Interrupted input"));
    await setTimeout(150);
    assert.equal(requests, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await runtime?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
