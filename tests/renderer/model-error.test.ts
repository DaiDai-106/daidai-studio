import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDisplay } from "../../src/renderer/scene/model.ts";
import type { ImportedModel } from "../../src/shared/display.ts";

test("a missing saved resource explains that it must be restored before reloading", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  const model = { manifest: { url: "dai-resource://missing/manifest" } } as ImportedModel;
  await assert.rejects(loadDisplay(model, new AbortController().signal), /恢复文件或重新解析 STEP/);
});
