import assert from "node:assert/strict";
import { test } from "node:test";
import { createCaptureQueue } from "../../../src/renderer/scene/captureQueue.ts";
import type { ApplicationEvent, ViewportCapture } from "../../../src/shared/application.ts";

const request: Extract<ApplicationEvent, { type: "viewport.capture" }> = {
  type: "viewport.capture",
  id: "capture-1",
  conversationId: "conversation-1",
  importId: "a".repeat(64),
  revision: 12,
  view: "overview",
};
const image: ViewportCapture = {
  image: { mimeType: "image/png", data: "data" },
  camera: {
    position: [0, 0, 1],
    target: [0, 0, 0],
    up: [0, 1, 0],
    projection: "orthographic",
  },
};

test("capture waits for the requested model and placement and then replies once", () => {
  const replies: unknown[] = [];
  let captures = 0;
  const queue = createCaptureQueue(
    () => {
      captures++;
      return image;
    },
    (id, result) => replies.push([id, result]),
  );
  queue.update({ concealed: false, status: "ready", importId: request.importId, revision: 11 });
  queue.request(request);
  assert.equal(captures, 0);
  queue.update({ concealed: false, status: "loading", importId: request.importId, revision: 12 });
  assert.equal(captures, 0);
  queue.update({ concealed: false, status: "ready", importId: request.importId, revision: 12 });
  assert.deepEqual(replies, [[request.id, image]]);
  queue.update({ concealed: false, status: "ready", importId: request.importId, revision: 12 });
  assert.equal(captures, 1);
  queue.dispose();
});

test("capture cannot use a newer revision and cancellation suppresses later capture", () => {
  const replies: unknown[] = [];
  let captures = 0;
  const queue = createCaptureQueue(
    () => {
      captures++;
      return image;
    },
    (id, result) => replies.push([id, result]),
  );
  queue.update({ concealed: false, status: "ready", importId: request.importId, revision: 13 });
  queue.request(request);
  assert.deepEqual(replies, [[request.id, null]]);
  queue.update({ concealed: false, status: "loading", importId: request.importId, revision: 11 });
  queue.request(request);
  queue.cancel(request.id);
  queue.update({ concealed: false, status: "ready", importId: request.importId, revision: 12 });
  assert.equal(captures, 0);
  assert.equal(replies.length, 1);
  queue.dispose();
});

test("capture waiting for a display times out without taking an image", async () => {
  const replies: unknown[] = [];
  const queue = createCaptureQueue(
    () => {
      assert.fail("must not capture an unready viewport");
    },
    (id, result) => replies.push([id, result]),
    10,
  );
  queue.update({ concealed: false, status: "loading", importId: undefined, revision: 0 });
  queue.request(request);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(replies, [[request.id, null]]);
  queue.dispose();
});
