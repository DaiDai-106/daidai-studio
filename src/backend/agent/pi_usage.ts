import type { SessionEntry, SessionStats } from "@earendil-works/pi-coding-agent";
import type { UsageInfo } from "../../contracts/application.ts";
export type ModelContext = (
  provider: string,
  model: string,
) =>
  | {
      contextWindow: number;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    }
  | undefined;

// 未创建 Agent 的历史也可查看；按 Pi getSessionStats 的条目范围恢复统计。
export function projectUsage(
  entries: SessionEntry[],
  modelContext: ModelContext,
  stats?: SessionStats,
): UsageInfo {
  const result: UsageInfo = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
  };
  let known = true;
  let seen = false;
  let cost = 0;
  for (const entry of entries) {
    const message = entry.type === "message" ? entry.message : undefined;
    const usage =
      entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
        ? entry.usage
        : message?.role === "assistant" || message?.role === "toolResult"
          ? message.usage
          : undefined;
    if (!usage) continue;
    seen = true;
    const provider =
      entry.type === "usage"
        ? entry.provider
        : message?.role === "assistant"
          ? message.provider
          : undefined;
    const model =
      entry.type === "usage"
        ? entry.model
        : message?.role === "assistant"
          ? message.model
          : undefined;
    const prices = provider && model ? modelContext(provider, model)?.cost : undefined;
    const value = usage.cost.total;
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      (value === 0 &&
        !usage.cost.totalFromProvider &&
        !Object.values(prices ?? {}).some((price) => price > 0))
    )
      known = false;
    else cost += value;
    if (!stats) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
        result[key] += Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : 0;
    }
  }
  if (stats) {
    result.input = stats.tokens.input;
    result.output = stats.tokens.output;
    result.cacheRead = stats.tokens.cacheRead;
    result.cacheWrite = stats.tokens.cacheWrite;
    result.totalTokens = stats.tokens.total;
  } else result.totalTokens = result.input + result.output + result.cacheRead + result.cacheWrite;
  result.estimatedCostUsd = seen && known ? (stats?.cost ?? cost) : null;
  return result;
}
