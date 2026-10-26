import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { _electron as electron } from "playwright";
import type { McpConfig } from "../../src/shared/capabilities.ts";
import { openTestProject } from "./support.ts";

test("desktop inspection respects its configured deadline and remains cancellable beyond the ordinary IPC timeout", {
  timeout: 60_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "dai-mcp-deadline-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${profile}`],
    env,
    chromiumSandbox: true,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(7000);
    await openTestProject(app, page, profile);
    const projectId = await page.evaluate(
      async () => (await window.desktop.application.getWorkspace()).projects[0]?.id,
    );
    assert.ok(projectId);
    const ready = join(profile, "ready"),
      closed = join(profile, "closed");
    const config: McpConfig = {
      id: "long-inspection",
      name: "Slow local initialization",
      enabled: true,
      modes: ["general"],
      scope: { kind: "project", projectId },
      transport: "stdio",
      command: process.execPath,
      args: ["--experimental-strip-types", resolve("tests/fixtures/mcp-stalled.ts"), ready, closed],
      timeoutMs: 50_000,
    };
    await page.evaluate(
      ({ config, projectId }) => {
        Reflect.set(window, "inspectionOutcome", "pending");
        void window.desktop.application.inspectMcp(config, projectId).then(
          () => Reflect.set(window, "inspectionOutcome", "succeeded"),
          (error: unknown) =>
            Reflect.set(
              window,
              "inspectionOutcome",
              error instanceof Error ? error.message : "failed",
            ),
        );
      },
      { config, projectId },
    );
    for (let index = 0; index < 200; index++) {
      if ((await readFile(ready, "utf8").catch(() => "")) === "ready") break;
      await setTimeout(20);
    }
    assert.equal(await readFile(ready, "utf8"), "ready");
    // Cross the real IPC deadline; the actual external process remains alive until cancellation.
    await setTimeout(31_100);
    assert.equal(await page.evaluate(() => Reflect.get(window, "inspectionOutcome")), "pending");
    await page.evaluate((id) => window.desktop.application.cancelMcpInspection(id), config.id);
    await page.waitForFunction(() =>
      String(Reflect.get(window, "inspectionOutcome")).includes("已停止"),
    );
    assert.equal(await readFile(closed, "utf8"), "closed");
    assert.equal(
      await page.evaluate(
        async () => (await window.desktop.application.getWorkspace()).projects.length,
      ),
      1,
    );
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
