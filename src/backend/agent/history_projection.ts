import type { SessionManager, SessionStats } from "@earendil-works/pi-coding-agent";
import { projectPiHistory } from "./pi_projection.ts";
import { type ModelContext, projectUsage } from "./pi_usage.ts";

/** 分支叶节点不变时复用投影，避免每个流式片段遍历完整历史。 */
export function createHistoryProjection(modelContext: ModelContext = () => undefined) {
  let cache = new WeakMap<
    SessionManager,
    {
      key: string;
      value: ReturnType<typeof projectPiHistory> & {
        branchUsage: ReturnType<typeof projectPiHistory>["usage"];
      };
    }
  >();
  function get(manager: SessionManager, statistics?: () => SessionStats) {
    const key = `${manager.getSessionId()}:${manager.getLeafId() ?? "root"}`;
    let entry = cache.get(manager);
    if (entry?.key !== key) {
      const projected = projectPiHistory(manager.getBranch(), modelContext);
      entry = {
        key,
        value: {
          ...projected,
          branchUsage: projected.usage,
          usage: projectUsage(manager.getEntries(), modelContext, statistics?.()),
        },
      };
      cache.set(manager, entry);
    }
    return { historyKey: key, ...entry.value };
  }
  return {
    get,
    clear: () => {
      cache = new WeakMap();
    },
  };
}
