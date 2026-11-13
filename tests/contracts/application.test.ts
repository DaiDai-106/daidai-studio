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

test("项目元数据不再携带旧 STEP 文件清单", () => {
  const project = {
    id: "project",
    name: "Coding",
    mode: "coding",
    path: "/tmp/project",
    available: true,
  };
  validateResult("project.refresh", project);
  assert.throws(() =>
    validateResult("project.refresh", { ...project, files: [], filesComplete: false }),
  );
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

test("Pi 推理档在应用请求中保持可选且严格校验", () => {
  validateRequest("conversation.update", { id: "chat" });
  for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    validateRequest("conversation.update", { id: "chat", thinkingLevel });
  }
  assert.throws(() =>
    validateRequest("conversation.update", { id: "chat", thinkingLevel: "invalid" }),
  );
});
