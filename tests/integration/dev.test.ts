import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveConfig } from "electron-vite";
import { _electron as electron } from "playwright";
import { createServer } from "vite";

test("development renderer survives Vite full reloads", {
  timeout: 30_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "dai-dev-"));
  const { config } = await resolveConfig({}, "serve", "development");
  assert.ok(config?.renderer);
  const server = await createServer({
    ...config.renderer,
    cacheDir: join(profile, "vite-cache"),
    server: { ...config.renderer.server, port: 0 },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
      ),
    );
    env.ELECTRON_RENDERER_URL = url;
    const application = await electron.launch({
      args: [process.cwd(), `--user-data-dir=${profile}`],
      env,
      chromiumSandbox: true,
    });
    try {
      const page = await application.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const welcome = page.getByRole("heading", { name: "项目", exact: true });
      await welcome.waitFor();
      await page.waitForFunction(() => document.querySelector("vite-error-overlay") === null);
      const origin = await page.evaluate(() => performance.timeOrigin);
      server.ws.send({ type: "full-reload" });
      await page.waitForFunction((previous) => performance.timeOrigin !== previous, origin);
      await welcome.waitFor();
      assert.equal(await page.evaluate(() => !!window.desktop), true);
      assert.deepEqual(errors, []);
    } finally {
      await application.close();
    }
  } finally {
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
