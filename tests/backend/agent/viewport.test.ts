import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createViewportCapture } from "../../../src/backend/agent/viewport.ts";
import type { ApplicationEvent } from "../../../src/shared/application.ts";

test("cancelled capture notifies the renderer and ignores delayed responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dai-capture-"));
  const importId = "a".repeat(64);
  const model = {
    importId,
    sourceHash: "b".repeat(64),
    importFingerprint: "c".repeat(64),
    resources: [],
  };
  const run = {
    conversationId: "chat",
    project: { id: "project", path: directory },
    sourceId: "step",
    source: null,
    selectedSourcePath: null,
    skill: null,
  };
  const artifacts = { get: async () => model, directory: async () => directory };
  const placements = { flush: async () => {}, get: async () => ({ revision: 2 }) };
  const events: ApplicationEvent[] = [];
  let dispatched!: () => void;
  const dispatchedPromise = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const viewport = createViewportCapture(
    () => run,
    artifacts as never,
    placements as never,
    (event) => {
      events.push(event);
      if (event.type === "viewport.capture") dispatched();
    },
  );
  try {
    const abort = new AbortController();
    const capture = viewport.capture({ importId, revision: 2 }, abort.signal);
    await dispatchedPromise;
    abort.abort(new Error("已停止"));
    await assert.rejects(capture, /已停止/);
    const event = events.find((item) => item.type === "viewport.capture");
    assert.ok(event && event.type === "viewport.capture");
    assert.ok(
      events.some((item) => item.type === "viewport.capture.cancel" && item.id === event.id),
    );
    viewport.respond(event.id, null);
    await assert.rejects(
      viewport.capture({ importId, revision: 1 }, new AbortController().signal),
      /场景或定位版本已变化/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
