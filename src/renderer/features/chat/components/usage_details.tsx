import { useState } from "react";
import type {
  ConversationView,
  ResponseInfo,
  UsageInfo,
} from "../../../../contracts/application.ts";
import { Dialog } from "../../../shared/components/dialog.tsx";

const tokens = (value: number) => value.toLocaleString("en-US");

function cost(value: number | null) {
  if (value === null) return "未提供价格";
  if (value > 0 && value < 0.0001) return "< $0.0001";
  return `$${value.toFixed(4)}`;
}

function cacheRate(usage: UsageInfo) {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  // Pi 会将缺失的缓存计数归零，因此零值不能证明模型支持缓存。
  return input > 0 && usage.cacheRead > 0
    ? `${((usage.cacheRead / input) * 100).toFixed(1)}%`
    : "—";
}

function contextSize(response: ResponseInfo | null) {
  if (!response || response.usage.totalTokens === 0) return "—";
  const used = tokens(response.usage.totalTokens);
  return response.contextWindow
    ? `${used} / ${tokens(response.contextWindow)} (${((response.usage.totalTokens / response.contextWindow) * 100).toFixed(1)}%)`
    : `${used} tokens · 窗口未知`;
}

function UsageButton({
  usage,
  response,
  cumulative,
  branchUsage,
}: {
  usage: UsageInfo;
  response: ResponseInfo | null;
  cumulative: boolean;
  branchUsage?: UsageInfo | undefined;
}) {
  const [open, setOpen] = useState(false);
  const title = cumulative ? "对话用量" : "本次响应用量";
  return (
    <>
      <button
        type="button"
        className="usage-summary"
        aria-label={title}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span>
          {cumulative ? "累计 " : ""}
          {tokens(usage.totalTokens)} tokens
        </span>
        <span>
          {usage.estimatedCostUsd === null ? cost(null) : `估算 ${cost(usage.estimatedCostUsd)}`}
        </span>
      </button>
      {open && (
        <Dialog title={title} onClose={() => setOpen(false)}>
          <dl className="usage-details">
            <dt>{cumulative ? "最近回复模型" : "回复模型"}</dt>
            <dd>{response?.model ?? "尚无回复"}</dd>
            <dt>输入 tokens（含缓存）</dt>
            <dd>{tokens(usage.input + usage.cacheRead + usage.cacheWrite)}</dd>
            <dt>未缓存输入</dt>
            <dd>{tokens(usage.input)}</dd>
            <dt>缓存读取</dt>
            <dd>{tokens(usage.cacheRead)}</dd>
            <dt>缓存写入</dt>
            <dd>{tokens(usage.cacheWrite)}</dd>
            <dt>输出 tokens（含推理）</dt>
            <dd>{tokens(usage.output)}</dd>
            {branchUsage && (
              <>
                <dt>当前分支 tokens</dt>
                <dd>{tokens(branchUsage.totalTokens)}</dd>
              </>
            )}
            <dt>总 tokens</dt>
            <dd>{tokens(usage.totalTokens)}</dd>
            <dt>缓存命中率</dt>
            <dd>{cacheRate(usage)}</dd>
            <dt>估算费用（USD）</dt>
            <dd>{cost(usage.estimatedCostUsd)}</dd>
            <dt>最近已报告上下文</dt>
            <dd>{contextSize(response)}</dd>
          </dl>
        </Dialog>
      )}
    </>
  );
}

export function ConversationUsage({ view }: { view: ConversationView }) {
  if (view.usage.totalTokens === 0) return null;
  return (
    <div className="conversation-usage">
      <UsageButton
        usage={view.usage}
        response={view.latestResponse}
        branchUsage={view.branchUsage}
        cumulative
      />
    </div>
  );
}

export function ResponseUsage({ response }: { response: ResponseInfo }) {
  if (response.usage.totalTokens === 0) return null;
  return <UsageButton usage={response.usage} response={response} cumulative={false} />;
}
