import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron } from "playwright";
import packageInfo from "../../package.json" with { type: "json" };
import { BACKEND_READY, BACKEND_SHUTDOWN } from "../../src/shared/desktop.ts";
import { openTestProject } from "./support.ts";

// Copy the built entry and replace only the backend when a test needs controlled timing.
// Production code has no test flags or alternate startup paths.
async function launchFixture(
  context: TestContext,
  options: { backendSource?: string; quitOnLoad?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "dai-lifecycle-"));
  let application: ElectronApplication | undefined;
  let child: ChildProcess | undefined;
  context.after(async () => {
    try {
      if (application && child?.exitCode === null) await application.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
  await cp(dist, join(directory, "dist"), { recursive: true });
  await cp(
    fileURLToPath(new URL("../../resources/skills/", import.meta.url)),
    join(directory, "resources/skills"),
    { recursive: true },
  );
  await symlink(
    join(process.cwd(), "node_modules"),
    join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  if (options.backendSource) {
    await writeFile(join(directory, "dist/main/backend.js"), options.backendSource);
  }
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: packageInfo.name,
      version: packageInfo.version,
      type: "module",
      main: "entry.js",
    }),
  );
  const report = join(directory, "windows.log");
  await writeFile(report, "");
  await writeFile(
    join(directory, "entry.js"),
    `import { app } from "electron";
import { appendFileSync } from "node:fs";
app.on("browser-window-created", (_event, window) => {
  appendFileSync(${JSON.stringify(report)}, ${JSON.stringify("created\n")});
  window.on("show", () => appendFileSync(${JSON.stringify(report)}, ${JSON.stringify("shown\n")}));
  ${options.quitOnLoad ? 'window.webContents.once("did-start-loading", () => app.quit());' : ""}
});
await import("./dist/main/index.js");
`,
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  const launchOptions = {
    args: [directory, `--user-data-dir=${join(directory, "profile")}`],
    env,
    chromiumSandbox: true,
  };
  application = await electron.launch(launchOptions);
  child = application.process();
  const exited = once(child, "exit", { signal: AbortSignal.timeout(15_000) });
  return { application, child, exited, report, directory, launchOptions };
}

async function relaunch(fixture: Awaited<ReturnType<typeof launchFixture>>) {
  const child = spawn(fixture.child.spawnfile, fixture.launchOptions.args, {
    env: fixture.launchOptions.env,
    stdio: "ignore",
  });
  try {
    const [code] = await once(child, "exit", { signal: AbortSignal.timeout(10_000) });
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

test("quitting before backend readiness never creates a window", {
  timeout: 25_000,
}, async (context) => {
  const fixture = await launchFixture(context, {
    backendSource: `process.parentPort.on("message", ({ data }) => {
  if (data === ${JSON.stringify(BACKEND_SHUTDOWN)}) {
    process.parentPort.postMessage(${JSON.stringify(BACKEND_READY)});
    setTimeout(() => process.exit(0), 200);
  }
});`,
  });
  await relaunch(fixture);
  await fixture.application.evaluate(({ app }) => app.quit());
  const [code] = await fixture.exited;
  assert.equal(code, 0);
  assert.equal(await readFile(fixture.report, "utf8"), "");
});

test("quitting during page loading does not show the window or report startup failure", {
  timeout: 25_000,
}, async (context) => {
  const fixture = await launchFixture(context, { quitOnLoad: true });
  const [code] = await fixture.exited;
  assert.equal(code, 0);
  const events = await readFile(fixture.report, "utf8");
  assert.ok(events.includes("created"));
  assert.ok(!events.includes("shown"));
});

test("repeated quit and relaunch do not reopen the window; timeout cleans up and releases the lock", {
  timeout: 25_000,
}, async (context) => {
  const fixture = await launchFixture(context, {
    backendSource: `import { appendFileSync } from "node:fs";
process.parentPort.on("message", ({ data }) => {
  if (data === ${JSON.stringify(BACKEND_SHUTDOWN)}) {
    appendFileSync(new URL("./shutdown.log", import.meta.url), ${JSON.stringify("shutdown\n")});
  }
});
process.parentPort.postMessage(${JSON.stringify(BACKEND_READY)});`,
  });
  const page = await fixture.application.firstWindow();
  await page
    .getByRole("button", { name: `应用信息，版本 ${packageInfo.version}`, exact: true })
    .waitFor();
  const backendPid = await fixture.application.evaluate(({ app, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.hide();
    const pid = app.getAppMetrics().find((metric) => metric.name === "daidai-pi-backend")?.pid;
    app.quit();
    app.quit();
    return pid;
  });
  assert.ok(backendPid);
  await relaunch(fixture);
  assert.equal(
    await fixture.application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isVisible(),
    ),
    false,
  );
  const [code] = await fixture.exited;
  assert.equal(code, 0);
  assert.throws(() => process.kill(backendPid, 0), { code: "ESRCH" });
  assert.equal(
    await readFile(join(fixture.directory, "dist/main/shutdown.log"), "utf8"),
    "shutdown\n",
  );

  await cp(
    fileURLToPath(new URL("../../dist/main/backend.js", import.meta.url)),
    join(fixture.directory, "dist/main/backend.js"),
  );
  const restarted = await electron.launch(fixture.launchOptions);
  const restartedChild = restarted.process();
  try {
    const restartedPage = await restarted.firstWindow();
    await restartedPage
      .getByRole("button", { name: `应用信息，版本 ${packageInfo.version}`, exact: true })
      .waitFor();
  } finally {
    if (restartedChild.exitCode === null) await restarted.close();
  }
  assert.equal(restartedChild.exitCode, 0);
});

test("a backend crash while hidden exits the app instead of leaving a stale tray instance", {
  timeout: 25_000,
}, async (context) => {
  const fixture = await launchFixture(context);
  const page = await fixture.application.firstWindow();
  await page
    .getByRole("button", { name: `应用信息，版本 ${packageInfo.version}`, exact: true })
    .waitFor();
  const backendPid = await fixture.application.evaluate(({ app, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.hide();
    return app.getAppMetrics().find((metric) => metric.name === "daidai-pi-backend")?.pid;
  });
  assert.ok(backendPid);
  process.kill(backendPid, "SIGKILL");
  const [code] = await fixture.exited;
  assert.equal(code, 1);
  assert.throws(() => process.kill(backendPid, 0), { code: "ESRCH" });
});

test("backend crash while the renderer is flushing a draft does not hang quitting", {
  timeout: 25_000,
}, async (context) => {
  const fixture = await launchFixture(context);
  const page = await fixture.application.firstWindow();
  await openTestProject(fixture.application, page, fixture.directory);
  await page.getByRole("textbox", { name: "消息内容" }).fill("待保存草稿");
  await fixture.application.evaluate(({ app }) => {
    const pid = app.getAppMetrics().find((metric) => metric.name === "daidai-pi-backend")?.pid;
    if (!pid) throw new Error("Missing backend");
    app.quit();
    process.kill(pid, "SIGKILL");
  });
  const [code] = await fixture.exited;
  assert.equal(code, 1);
});
