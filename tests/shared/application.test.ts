import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationInfo } from "../../src/backend/projects/documents.ts";
import { validateResult } from "../../src/shared/application.ts";

test("conversation projections exclude persistence flags from the strict public contract", () => {
  const record = {
    id: "1",
    projectId: "project-1",
    title: "Test",
    mode: "general" as const,
    modelId: "",
    draft: "",
    archived: false,
    interrupted: false,
    deletedAt: "",
  };
  assert.throws(() => validateResult("conversation.create", record));
  validateResult("conversation.create", conversationInfo(record));
  assert.equal(Object.hasOwn(conversationInfo(record), "deletedAt"), false);
});

test("protocol errors identify the failed method without exposing response contents", () => {
  assert.throws(
    () => validateResult("provider.models", { unexpected: "private-response-content" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /provider\.models/);
      assert.ok(!error.message.includes("private-response-content"));
      return true;
    },
  );
  validateResult("conversation.delete", null);
});
