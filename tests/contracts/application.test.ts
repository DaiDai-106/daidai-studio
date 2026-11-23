import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRequest, validateResult } from "../../src/contracts/application.ts";

test("项目模式在创建时由严格的请求契约校验", () => {
  validateRequest("project.create", { name: "代码", mode: "coding", path: "/tmp/project" });
  assert.throws(() =>
    validateRequest("project.create", { name: "旧项目", mode: "robot", path: "/tmp/project" }),
  );
  validateRequest("project.create", { name: "场景", mode: "scene", path: "/tmp/project" });
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

test("主题回退比较条件通过设置契约传输并拒绝无效类型", () => {
  validateRequest("settings.update", { desktopTheme: "", expectedDesktopTheme: "theme:a" });
  assert.throws(() =>
    validateRequest("settings.update", { desktopTheme: "", expectedDesktopTheme: 1 }),
  );
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

test("插件范围独立于项目，市场与模块标识严格校验", () => {
  assert.throws(() =>
    validateRequest("catalog.search", { sourceId: "builtin", query: "", offset: 0 }),
  );
  validateRequest("catalog.packageAction", {
    action: "install",
    source: "npm:demo",
    scope: "global",
  });
  for (const moduleId of ["coding", "scene"])
    validateRequest("catalog.packageAction", {
      action: "install",
      source: "npm:demo",
      scope: "module",
      moduleId,
    });
  assert.throws(() =>
    validateRequest("catalog.packageAction", {
      action: "install",
      source: "npm:demo",
      scope: "project",
      projectId: "a",
    }),
  );
  assert.throws(() => validateRequest("catalog.installed", { moduleId: "../escape" }));
  assert.throws(() => validateRequest("catalog.installed", { moduleId: "robot" }));
  validateRequest("skill.library.list", { moduleId: "coding" });
  assert.throws(() => validateRequest("skill.library.list", { projectId: "old-project" }));
  assert.throws(() => validateRequest("skill.library.list", { moduleId: "../escape" }));
});
