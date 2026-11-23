import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchElectron } from "./support.ts";

test("失效默认型号显示明确提示，不进入模型选择且可停用服务", { timeout: 30_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "dai-retired-ui-"));
  const path = join(profile, "data/agent/settings.json");
  await mkdir(join(profile, "data/agent"), { recursive: true });
  const model = { id: "example", name: "Example", context: 4096, output: 1024, reasoning: "标准" };
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      deviceId: randomUUID(),
      defaultModel: "qwen:deepseek-v4-flash",
      providers: [
        {
          id: "qwen",
          name: "Old Qwen",
          providerType: "qwen-token-plan",
          authMethod: "environment",
          endpoint: "",
          enabled: true,
          secretRef: "",
          models: [{ ...model, id: "deepseek-v4-flash", name: "Old DeepSeek" }],
        },
        {
          id: "local",
          name: "Local",
          providerType: "local",
          authMethod: "none",
          endpoint: "http://127.0.0.1:1/v1",
          enabled: true,
          secretRef: "",
          models: [model],
        },
      ],
    }),
  );
  const application = await launchElectron(profile);
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "打开设置", exact: true }).click();
    await page.getByRole("button", { name: "AI 设置", exact: true }).click();
    const select = page.getByRole("button", { name: "默认模型", exact: true });
    assert.match((await select.textContent()) ?? "", /默认模型已不可用/);
    await page.getByText("型号已不可用，请编辑并重新选择", { exact: true }).waitFor();
    await page.getByText("默认（已不可用）", { exact: true }).waitFor();
    await select.click();
    assert.equal(
      await page.getByRole("menuitemradio", { name: "Example · Local", exact: true }).count(),
      1,
    );
    assert.equal(await page.getByRole("menuitemradio", { name: /Old DeepSeek/ }).count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(JSON.parse(await readFile(path, "utf8")).defaultModel, "qwen:deepseek-v4-flash");
    const toggle = page.getByRole("switch", { name: "启用 Old Qwen", exact: true });
    await toggle.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="switch"][aria-label="启用 Old Qwen"]')
          ?.getAttribute("aria-checked") === "false",
    );
    const saved = JSON.parse(await readFile(path, "utf8"));
    const qwen = saved.providers.find((provider: { id: string }) => provider.id === "qwen");
    assert.equal(qwen.enabled, false);
    assert.equal(qwen.models[0].id, "deepseek-v4-flash");
    assert.equal(Object.hasOwn(qwen, "unavailableModels"), false);
    assert.equal(Object.hasOwn(qwen, "configured"), false);
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});
