import { useState } from "react";
import type { ConversationView, ResponseInfo, UsageInfo } from "../../shared/application.ts";
import { Dialog } from "../components/Dialog.tsx";

const tokens = (value: number) => value.toLocaleString("en-US");
function cost(value: number | null) {
  if (value === null) return "未提供价格";
  if (value > 0 && value < 0.0001) return "< $0.0001";
  return `$${value.toFixed(4)}`;
}
function cacheRate(usage: UsageInfo) {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  // Pi normalizes missing cache counters to zero; zero cannot prove support.
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
}: {
  usage: UsageInfo;
  response: ResponseInfo | null;
  cumulative: boolean;
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
        {cumulative && <span>缓存 {cacheRate(usage)}</span>}
        {cumulative && (
          <span>
            上下文{" "}
            {response?.contextWindow && response.usage.totalTokens > 0
              ? `${((response.usage.totalTokens / response.contextWindow) * 100).toFixed(1)}%`
              : "—"}
          </span>
        )}
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
            <dt>总 tokens</dt>
            <dd>{tokens(usage.totalTokens)}</dd>
            <dt>缓存命中率</dt>
            <dd>{cacheRate(usage)}</dd>
            <dt>估算费用（USD）</dt>
            <dd>{cost(usage.estimatedCostUsd)}</dd>
            <dt>最近已报告上下文</dt>
            <dd>{contextSize(response)}</dd>
          </dl>
          <p className="usage-explanation">
            {cumulative && "累计值来自本对话的模型请求，包含重试与压缩消耗。"}
            缓存命中率为缓存读取占全部输入的比例；“—”表示尚无用量或未报告缓存命中。
            上下文按最近已报告用量的请求的输入加输出计算，不是下一次请求的精确长度。费用沿用 pi-ai
            的模型价格估算，不代表账单；订阅或无定价服务可能无法估算。
            {cumulative &&
              usage.estimatedCostUsd === null &&
              "部分请求缺少价格，因此不展示完整对话费用。"}
          </p>
        </Dialog>
      )}
    </>
  );
}

export function ConversationUsage({ view }: { view: ConversationView }) {
  if (view.usage.totalTokens === 0) return null;
  return (
    <div className="conversation-usage">
      <UsageButton usage={view.usage} response={view.latestResponse} cumulative />
    </div>
  );
}

export function ResponseUsage({ response }: { response: ResponseInfo }) {
  if (response.usage.totalTokens === 0) return null;
  return <UsageButton usage={response.usage} response={response} cumulative={false} />;
}
