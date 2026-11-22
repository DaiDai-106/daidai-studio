import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Results } from "../../contracts/application.ts";
import type { openProjectStore } from "../projects/store.ts";
import { entryModel, entryUsage, type ModelContext, projectUsage } from "./pi_usage.ts";

function validPath(directory: string, file: string) {
  const rel = relative(directory, file);
  return Boolean(rel && !rel.startsWith("..") && !isAbsolute(rel) && rel.endsWith(".jsonl"));
}

async function readSession<T>(
  path: string,
  read: (parent: string | null, lines: AsyncIterator<string>) => Promise<T> | T,
) {
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    const lines = reader[Symbol.asyncIterator]();
    const header = JSON.parse((await lines.next()).value ?? "");
    if (header?.type !== "session") throw new Error("invalid session");
    return await read(
      typeof header.parentSession === "string" ? header.parentSession : null,
      lines,
    );
  } finally {
    reader.close();
    stream.destroy();
  }
}

function usageEvent(entry: SessionEntry, root: string, modelContext: ModelContext) {
  if (!entry || typeof entry !== "object") throw new Error("invalid session entry");
  const usage = entryUsage(entry);
  if (!usage) return;
  const { provider, model } = entryModel(entry) ?? { provider: "", model: "" };
  if (
    ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
    ) ||
    !usage.cost ||
    typeof usage.cost.total !== "number" ||
    typeof provider !== "string" ||
    provider.length > 200 ||
    typeof model !== "string" ||
    model.length > 500 ||
    typeof entry.timestamp !== "string" ||
    entry.timestamp.length > 100 ||
    !Number.isFinite(Date.parse(entry.timestamp))
  )
    throw new Error("invalid session usage");
  return {
    id: createHash("sha256").update(root).update("\0").update(JSON.stringify(entry)).digest("hex"),
    timestamp: entry.timestamp,
    provider: provider || "未知",
    model: model || "未知",
    ...projectUsage([entry], modelContext),
  };
}

/** 按行读取应用管理的会话，已删除的祖先文件仅用于追溯分叉。 */
export async function usageDashboard(
  store: ReturnType<typeof openProjectStore>,
  dataRoot: string,
  modelContext: ModelContext,
): Promise<Results["usage.dashboard"]> {
  const parents = new Map<string, string | null>();
  const events = new Map<string, Results["usage.dashboard"]["events"][number]>();
  let incomplete = 0;

  async function rootFor(path: string, directory: string) {
    const visited = new Set<string>();
    let root = path;
    for (;;) {
      if (visited.has(root)) {
        incomplete++;
        return root;
      }
      visited.add(root);
      if (!parents.has(root)) {
        try {
          parents.set(root, await readSession(root, (parent) => parent));
        } catch {
          incomplete++;
          return root;
        }
      }
      const parent = parents.get(root);
      if (!parent) return root;
      if (!validPath(directory, parent)) {
        incomplete++;
        return root;
      }
      root = parent;
    }
  }

  for (const file of store.usageHistories()) {
    if (!file.sessionFile) {
      if (file.hasMessages) incomplete++;
      continue;
    }
    const path = file.sessionFile;
    const directory = join(dataRoot, "agent", "sessions", file.projectId);
    if (!validPath(directory, path)) {
      incomplete++;
      continue;
    }
    try {
      await readSession(path, async (parent, lines) => {
        parents.set(path, parent);
        const root = await rootFor(path, directory);
        for (let next = await lines.next(); !next.done; next = await lines.next()) {
          if (!next.value.trim()) continue;
          try {
            const event = usageEvent(JSON.parse(next.value), root, modelContext);
            if (event && !events.has(event.id)) events.set(event.id, event);
          } catch {
            incomplete++;
          }
        }
      });
    } catch {
      if (file.hasMessages) incomplete++;
    }
  }
  return {
    events: [...events.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)),
    incomplete,
  };
}
