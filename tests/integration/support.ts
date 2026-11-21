import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TestContext } from "node:test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import type { Method } from "../../src/contracts/application.ts";
import { REQUEST_CHANNEL } from "../../src/contracts/desktop.ts";

export function testElectronEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
}

export function launchElectron(profile: string, env = testElectronEnvironment()) {
  return electron.launch({
    args: [process.cwd(), `--user-data-dir=${profile}`],
    env,
    chromiumSandbox: true,
  });
}

export async function launchTestApp(context: TestContext) {
  const profile = await mkdtemp(join(tmpdir(), "dai-ui-"));
  let application: ElectronApplication | undefined;
  context.after(async () => {
    try {
      if (application?.process().exitCode === null) await application.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
  application = await launchElectron(profile);
  return { application, page: await application.firstWindow(), profile };
}

// 暂缓单次现有 IPC 响应，读取和校验仍由生产处理器执行。
export async function holdApplicationResponses(application: ElectronApplication) {
  const requests = await application.evaluateHandle(({ ipcMain }, channel) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]>;
      }
    )._invokeHandlers;
    const handle = handlers.get(channel);
    if (!handle) throw new Error("缺少应用 IPC 入口。");
    const gates = new Map<
      string,
      { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
    >();
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, method, args) => {
      const key = `${method}:${args?.turnId ?? args?.id}`;
      const gate = gates.get(key);
      gates.delete(key);
      const result = await handle(event, method, args);
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      return result;
    });
    return gates;
  }, REQUEST_CHANNEL);
  return async (method: Method, id?: string) => {
    const handle = await requests.evaluateHandle((gates, key) => {
      const gate = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      gates.set(key, gate);
      return gate;
    }, `${method}:${id}`);
    return {
      entered: () => handle.evaluate((gate) => gate.entered.promise),
      async release() {
        await handle.evaluate((gate) => gate.release.resolve());
        await handle.dispose();
      },
    };
  };
}

export async function openTestProject(
  application: ElectronApplication,
  page: Page,
  profile: string,
) {
  const directory = join(profile, "project");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "example.ts"), "export const example = 1;\n");
  await chooseProject(application, page, directory);
  return directory;
}

export async function chooseProject(
  application: ElectronApplication,
  page: Page,
  directory: string,
) {
  // Only the native picker is substituted. Directory enumeration and all backend
  // persistence, authentication, rendering and IPC use the production code.
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, directory);
  await page.getByRole("button", { name: "新建项目", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await dialog.getByLabel("项目名称").fill(basename(directory));
  await dialog.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "新建对话", exact: true }).last().click();
  await page.getByRole("textbox", { name: "消息内容", exact: true }).waitFor();
}
