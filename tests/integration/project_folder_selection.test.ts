import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _electron as electron } from "playwright";

test("项目文件夹可直接选择，取消保留表单，未选择时使用默认目录", {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-project-selection-"));
  const documents = join(root, "documents");
  const selectedDirectory = join(root, "chosen");
  await Promise.all([mkdir(documents), mkdir(selectedDirectory)]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const application = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${join(root, "profile")}`],
    env,
    chromiumSandbox: true,
  });
  try {
    await application.evaluate(
      ({ app, dialog }, paths) => {
        app.setPath("documents", paths.documents);
        const choices = [paths.selectedDirectory, null, paths.selectedDirectory];
        dialog.showOpenDialog = async () => {
          const path = choices.shift();
          return { canceled: !path, filePaths: path ? [path] : [] };
        };
      },
      { documents, selectedDirectory },
    );
    const page = await application.firstWindow();
    page.setDefaultTimeout(15_000);

    await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
    let form = page.getByRole("dialog", { name: "新建项目" });
    await form.getByLabel("项目名称").fill("默认项目");
    assert.match((await form.textContent()) ?? "", /默认在文稿\/Dai 中创建/);
    await form.getByRole("button", { name: "创建项目", exact: true }).click();
    await form.waitFor({ state: "hidden" });
    let workspace = await page.evaluate(() => window.desktop.application.getWorkspace());
    assert.equal(
      workspace.projects.find((project) => project.name === "默认项目")?.path,
      join(documents, "Dai", "默认项目"),
    );

    await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
    form = page.getByRole("dialog", { name: "新建项目" });
    await form.getByLabel("项目名称").fill("选择项目");
    await form.getByLabel("项目模式").click();
    await page.getByRole("menuitemradio", { name: "场景搭建" }).click();
    const choose = form.getByRole("button", { name: "选择文件夹", exact: true });
    await choose.click();
    await form.getByText(selectedDirectory, { exact: true }).waitFor();
    await choose.click();
    assert.equal(await form.getByLabel("项目名称").inputValue(), "选择项目");
    await form.getByText(selectedDirectory, { exact: true }).waitFor();
    await form.getByRole("button", { name: "创建项目", exact: true }).click();
    await form.waitFor({ state: "hidden" });
    workspace = await page.evaluate(() => window.desktop.application.getWorkspace());
    const selected = workspace.projects.find((project) => project.name === "选择项目");
    assert.equal(selected?.path, selectedDirectory);
    assert.equal(selected?.mode, "scene");

    const result = await page.evaluate(async () => {
      const chosen = await window.desktop.application.chooseProjectDirectory();
      if (!chosen) throw new Error("测试未选择目录。");
      let rejected = false;
      try {
        await window.desktop.application.createProject({
          name: "伪造",
          mode: "coding",
          directoryToken: "untrusted-token",
        });
      } catch {
        rejected = true;
      }
      const saved = await window.desktop.application.createProject({
        name: "合法",
        mode: "coding",
        directoryToken: chosen.token,
      });
      let reused = false;
      try {
        await window.desktop.application.createProject({
          name: "重复使用",
          mode: "coding",
          directoryToken: chosen.token,
        });
        reused = true;
      } catch {
        // 选择令牌成功提交后失效。
      }
      return { rejected, reused, path: saved?.path };
    });
    assert.deepEqual(result, { rejected: true, reused: false, path: selectedDirectory });
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("同一文件夹令牌不允许并发使用，失败可重试且保留期间的新选择", {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-project-selection-race-"));
  const firstDir = join(root, "first");
  const secondDir = join(root, "second");
  const retryDir = join(root, "retry");
  await Promise.all([mkdir(firstDir), mkdir(secondDir), mkdir(retryDir)]);

  let releaseRequest: ServerResponse | undefined;
  let requestStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const server = createServer((_request, response) => {
    releaseRequest = response;
    requestStarted();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动。");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  const application = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${join(root, "profile")}`],
    env,
    chromiumSandbox: true,
  });
  try {
    await application.evaluate(
      ({ dialog }, directories) => {
        const choices = [...directories];
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [choices.shift() ?? ""],
        });
      },
      [firstDir, secondDir, retryDir],
    );
    const page = await application.firstWindow();
    await page.evaluate((endpoint) => {
      // 模型发现阻塞后端串行队列，使创建请求保持在途。
      void window.desktop.application
        .getModels(
          {
            id: "blocking",
            name: "blocking",
            providerType: "local",
            authMethod: "none",
            endpoint,
            enabled: true,
            models: [],
          },
          undefined,
          true,
        )
        .catch(() => {});
    }, `http://127.0.0.1:${address.port}`);
    await Promise.race([
      started,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("测试服务未收到请求。")), 10_000),
      ),
    ]);

    const state = await page.evaluate(async () => {
      const api = window.desktop.application;
      const first = await api.chooseProjectDirectory();
      if (!first) throw new Error("测试未选择目录。");
      const pending = api.createProject({
        name: "first",
        mode: "coding",
        directoryToken: first.token,
      });
      void pending.catch(() => {});
      (window as unknown as { pendingProject: typeof pending }).pendingProject = pending;
      const concurrent = api.createProject({
        name: "duplicate",
        mode: "coding",
        directoryToken: first.token,
      });
      const result = await Promise.race([
        concurrent.then(
          () => "accepted",
          () => "rejected",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 1000)),
      ]);
      const next = await api.chooseProjectDirectory();
      return { result, next };
    });
    assert.equal(state.result, "rejected");
    assert.ok(state.next);
    releaseRequest?.writeHead(200, { "content-type": "application/json" });
    releaseRequest?.end(JSON.stringify({ data: [] }));
    const firstProject = await page.evaluate(
      () => (window as unknown as { pendingProject: Promise<{ path: string }> }).pendingProject,
    );
    assert.equal(firstProject.path, firstDir);
    const secondProject = await page.evaluate(
      (token) =>
        window.desktop.application.createProject({
          name: "second",
          mode: "coding",
          directoryToken: token,
        }),
      state.next.token,
    );
    assert.equal(secondProject?.path, secondDir);

    const retry = await page.evaluate(() => window.desktop.application.chooseProjectDirectory());
    assert.ok(retry);
    await rm(retryDir, { recursive: true });
    const failed = await page.evaluate(async (token) => {
      try {
        await window.desktop.application.createProject({
          name: "retry",
          mode: "coding",
          directoryToken: token,
        });
        return false;
      } catch {
        return true;
      }
    }, retry.token);
    assert.equal(failed, true);
    await mkdir(retryDir);
    const retried = await page.evaluate(
      (token) =>
        window.desktop.application.createProject({
          name: "retry",
          mode: "coding",
          directoryToken: token,
        }),
      retry.token,
    );
    assert.equal(retried?.path, retryDir);
  } finally {
    releaseRequest?.end();
    await application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
