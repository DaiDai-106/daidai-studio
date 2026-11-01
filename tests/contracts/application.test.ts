import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRequest, validateResult } from "../../src/contracts/application.ts";

test("项目模式在创建时由严格的请求契约校验", () => {
  validateRequest("project.create", { name: "机器人", mode: "robot", path: "/tmp/project" });
  assert.throws(() =>
    validateRequest("project.create", { name: "机器人", mode: "unknown", path: "/tmp/project" }),
  );
  assert.throws(() => validateRequest("conversation.update", { id: "chat", mode: "scene" }));
  assert.throws(() => validateRequest("mcp.save", { config: {} }));
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
