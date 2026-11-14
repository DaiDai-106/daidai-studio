import type { openApplication } from "../../src/backend/application.ts";
import type { Arguments } from "../../src/contracts/application.ts";
import type { CatalogTask } from "../../src/contracts/catalog.ts";

export async function waitForCatalogTask(
  read: () => CatalogTask[] | Promise<CatalogTask[]>,
  id: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const task = (await read()).find((item) => item.id === id);
    if (task && task.state !== "running") return task;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`插件任务未完成：${id}`);
}

export async function runPackageAction(
  app: Pick<Awaited<ReturnType<typeof openApplication>>, "request">,
  input: Arguments<"catalog.packageAction">,
) {
  const started = await app.request("catalog.packageAction", input);
  const task = await waitForCatalogTask(() => app.request("catalog.tasks", {}), started.id);
  if (task.state === "failed") throw new Error(task.message);
  return task;
}
