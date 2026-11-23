import { strict as assert } from "node:assert";
import { test } from "node:test";
import { rightPanePercent } from "../../../src/renderer/shared/logic/pane_size.ts";

test("面板比例以工作区边界计算并限制拖动范围", () => {
  assert.equal(rightPanePercent(900, { left: 300, right: 1500 }, 20, 80), 50);
  assert.equal(rightPanePercent(1100, { left: 500, right: 1700 }, 20, 80), 50);
  assert.equal(rightPanePercent(100, { left: 300, right: 1500 }, 20, 80), 80);
  assert.equal(rightPanePercent(1600, { left: 300, right: 1500 }, 20, 80), 20);
});
