import type { CatalogTask } from "../../../../contracts/catalog.ts";

/** 优先采用新事件；迟到的进行中记录不能覆盖终态。 */
export function mergePluginTasks(preferred: CatalogTask[], fallback: CatalogTask[]) {
  const merged = new Map<string, CatalogTask>();
  for (const task of [...preferred, ...fallback]) {
    const existing = merged.get(task.id);
    if (!existing || (existing.state === "running" && task.state !== "running"))
      merged.set(task.id, task);
  }
  return [...merged.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 100);
}
