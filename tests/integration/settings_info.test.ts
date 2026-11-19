import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import packageInfo from "../../package.json" with { type: "json" };
import { launchTestApp } from "./support.ts";

test("设置展示应用数据目录、本版更新、诊断和许可说明", { timeout: 60_000 }, async (context) => {
  const { page, profile } = await launchTestApp(context);
  page.setDefaultTimeout(10_000);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "本地数据", exact: true }).click();
  const data = page.locator(".settings-content-inner");
  await data.getByRole("heading", { name: "本地数据", exact: true }).waitFor();
  assert.equal(await data.locator(".setting-row").count(), 2);
  assert.equal(
    await data
      .locator(".setting-row")
      .filter({ hasText: "应用数据目录" })
      .locator("p")
      .textContent(),
    join(profile, "data"),
  );
  await data.getByRole("button", { name: "查看已归档对话" }).waitFor();

  await page.getByRole("button", { name: "信息", exact: true }).click();
  await page.getByRole("heading", { name: packageInfo.productName, exact: true }).waitFor();
  const releaseNotes = page.getByRole("region", { name: "本版更新", exact: true });
  await releaseNotes.getByText("Coding 工作区", { exact: true }).waitFor();
  await releaseNotes.getByText("用量 Dashboard", { exact: true }).waitFor();
  assert.equal(
    await releaseNotes.evaluate(
      (section) => section.previousElementSibling?.querySelector("p")?.textContent,
    ),
    packageInfo.version,
  );

  await page.getByRole("button", { name: "查看诊断范围", exact: true }).click();
  const diagnostics = page.getByRole("dialog", {
    name: `${packageInfo.productName} 诊断信息预览`,
  });
  await diagnostics.waitFor();
  const diagnosticOutput = await diagnostics.locator("pre").textContent();
  assert.ok(diagnosticOutput);
  const info = JSON.parse(diagnosticOutput);
  assert.equal(info.name, packageInfo.productName);
  assert.equal(info.version, packageInfo.version);
  assert.equal(info.dataRoot, join(profile, "data"));
  await diagnostics.getByRole("button", { name: "关闭弹窗" }).click();
  await diagnostics.waitFor({ state: "hidden" });

  await page.getByText("项目代码未声明开源许可证，第三方组件许可详见说明。").waitFor();
  await page.getByRole("button", { name: "查看许可说明" }).click();
  const license = page.getByRole("dialog", { name: "项目许可与第三方声明" });
  await license.waitFor();
  assert.equal(await license.locator("pre").textContent(), await readFile("LICENSE", "utf8"));
  await license.getByRole("button", { name: "关闭弹窗" }).click();
  await license.waitFor({ state: "hidden" });
});
