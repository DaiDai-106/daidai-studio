import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createExtensionUi } from "../../../src/backend/agent/extension_ui.ts";
import type { ApplicationEvent } from "../../../src/contracts/application.ts";

test("扩展对话按会话排队，取消只影响该会话，空选项是合法值", async () => {
  const events: ApplicationEvent[] = [];
  const manager = createExtensionUi((event) => events.push(event));
  const a = manager.context("a");
  const b = manager.context("b");
  const first = a.confirm("确认", "消息");
  const second = a.select("选择", ["", "A"]);
  const third = b.input("输入");
  assert.equal(manager.pending().length, 2);
  const requestB = manager.pending().find((item) => item.conversationId === "b");
  assert.ok(requestB);
  manager.respond({ requestId: requestB.requestId, cancelled: false, value: "hello" });
  assert.equal(await third, "hello");
  const requestA = manager.pending()[0];
  assert.ok(requestA);
  manager.respond({ requestId: requestA.requestId, cancelled: false, value: "true" });
  assert.equal(await first, true);
  const selection = manager.pending()[0];
  assert.ok(selection);
  assert.throws(
    () => manager.respond({ requestId: selection.requestId, cancelled: false, value: "missing" }),
    /无效/,
  );
  manager.respond({ requestId: selection.requestId, cancelled: false, value: "" });
  assert.equal(await second, "");
  const pendingA = a.confirm("停止后取消", "消息");
  const pendingB = b.input("仍然等待");
  manager.cancelConversation("a");
  assert.equal(await pendingA, false);
  assert.equal(manager.pending().length, 1);
  manager.close();
  assert.equal(await pendingB, undefined);
  assert.equal(manager.pending().length, 0);
  assert.ok(events.some((event) => event.type === "extension.ui.dismissed"));
});

test("规划场景选择绑定请求和类型，系统选择取消后释放等待", async () => {
  const manager = createExtensionUi(() => {});
  const picking = manager.choosePlanningSource("planning", "package");
  const [request] = manager.pending();
  assert.ok(request);
  assert.equal(request.kind, "planning-source");
  assert.equal(request.planningKind, "package");
  assert.throws(() => manager.checkPlanningSource(request.requestId, "urdf"), /无效/);
  assert.throws(
    () =>
      manager.respond({ requestId: request.requestId, cancelled: false, value: "/tmp/model.urdf" }),
    /请选择本地规划场景/,
  );
  manager.checkPlanningSource(request.requestId, "package");
  manager.respondPlanningSource(request.requestId, "package", "/tmp/robot-package");
  assert.deepEqual(await picking, { kind: "package", path: "/tmp/robot-package" });
  assert.throws(() => manager.checkPlanningSource(request.requestId, "package"), /已失效/);

  const cancelled = manager.choosePlanningSource("planning");
  const [next] = manager.pending();
  assert.ok(next);
  manager.respondPlanningSource(next.requestId, "urdf");
  assert.equal(await cancelled, undefined);
  assert.deepEqual(manager.pending(), []);
});
