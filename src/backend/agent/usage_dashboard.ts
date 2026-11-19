import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { openProjectStore } from "../projects/store.ts";
import { entryUsage, type ModelContext, projectUsage } from "./pi_usage.ts";

function validPath(directory: string, file: string) {
  const rel = relative(directory, file);
  return Boolean(rel && !rel.startsWith("..") && !isAbsolute(rel) && rel.endsWith(".jsonl"));
}

/** 只统计应用管理的会话；已删除的祖先文件只读取头部以追溯分叉。 */
export async function usageDashboard(
  store: ReturnType<typeof openProjectStore>,
  dataRoot: string,
  modelContext: ModelContext,
) {
  const loaded = new Map<
    string,
    { parent: string | null; directory: string; entries: SessionEntry[] }
  >();
  let incomplete = 0;
  for (const file of store.usageHistories()) {
    if (!file.sessionFile) {
      if (file.hasMessages) incomplete++;
      continue;
    }
    const directory = join(dataRoot, "agent", "sessions", file.projectId);
    if (!validPath(directory, file.sessionFile)) {
      incomplete++;
      continue;
    }
    try {
      const lines = (await readFile(file.sessionFile, "utf8")).split("\n");
      const header = JSON.parse(lines.shift() ?? "");
      if (header?.type !== "session") throw new Error("invalid session");
      const entries: SessionEntry[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          incomplete++;
        }
      }
      loaded.set(file.sessionFile, {
        parent: typeof header.parentSession === "string" ? header.parentSession : null,
        directory,
        entries,
      });
    } catch {
      if (file.hasMessages) incomplete++;
    }
  }
  const parents = new Map([...loaded].map(([path, file]) => [path, file.parent]));
  const seen = new Set<string>();
  const events = [];
  for (const [path, file] of loaded) {
    let root = path;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(root)) {
        incomplete++;
        break;
      }
      visited.add(root);
      if (!parents.has(root)) {
        if (!validPath(file.directory, root)) {
          incomplete++;
          break;
        }
        try {
          const stream = createReadStream(root, { encoding: "utf8" });
          const lines = createInterface({ input: stream, crlfDelay: Infinity });
          let header: unknown;
          try {
            for await (const line of lines) {
              header = JSON.parse(line);
              break;
            }
          } finally {
            lines.close();
            stream.destroy();
          }
          if (
            !header ||
            typeof header !== "object" ||
            !("type" in header) ||
            header.type !== "session"
          )
            throw new Error("invalid session");
          parents.set(
            root,
            "parentSession" in header && typeof header.parentSession === "string"
              ? header.parentSession
              : null,
          );
        } catch {
          incomplete++;
          break;
        }
      }
      const parent = parents.get(root);
      if (!parent) break;
      if (!validPath(file.directory, parent)) {
        incomplete++;
        break;
      }
      root = parent;
    }
    for (const entry of file.entries) {
      if (!entry || typeof entry !== "object") {
        incomplete++;
        continue;
      }
      const message = entry.type === "message" ? entry.message : undefined;
      const usage = entryUsage(entry);
      if (!usage) continue;
      const provider =
        entry.type === "usage"
          ? entry.provider
          : message?.role === "assistant"
            ? message.provider
            : "";
      const model =
        entry.type === "usage" ? entry.model : message?.role === "assistant" ? message.model : "";
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
      ) {
        incomplete++;
        continue;
      }
      const key = `${root}\0${JSON.stringify(entry)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        events.push({
          id: createHash("sha256").update(key).digest("hex"),
          timestamp: entry.timestamp,
          provider: provider || "未知",
          model: model || "未知",
          ...projectUsage([entry], modelContext),
        });
      } catch {
        incomplete++;
      }
    }
  }
  events.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return { events, incomplete };
}
