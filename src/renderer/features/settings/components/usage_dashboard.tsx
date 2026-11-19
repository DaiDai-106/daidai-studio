import { useEffect, useMemo, useState } from "react";
import type { ProviderInfo, Results } from "../../../../contracts/application.ts";
import { Select } from "../../../shared/components/select.tsx";
import { Tooltip } from "../../../shared/components/tooltip.tsx";

type Event = Results["usage.dashboard"]["events"][number];
const number = (value: number) =>
  new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
function startOfDay(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result.getTime();
}

export function UsageDashboard({
  load,
  providers: configured,
}: {
  load: () => Promise<Results["usage.dashboard"]>;
  providers: ProviderInfo[];
}) {
  const [data, setData] = useState<Results["usage.dashboard"]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [year, setYear] = useState("");
  const [mode, setMode] = useState<"day" | "week" | "cumulative">("day");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [limit, setLimit] = useState(25);
  useEffect(() => {
    let active = true;
    void version;
    setLoading(true);
    setError("");
    load()
      .then(
        (value) => {
          if (active) setData(value);
        },
        (reason: unknown) => {
          if (active) setError(reason instanceof Error ? reason.message : "读取失败");
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load, version]);
  const providers = useMemo(
    () => [...new Set(data?.events.map((event) => event.provider) ?? [])].sort(),
    [data],
  );
  function providerName(id: string) {
    if (id === "未知") return "未知服务";
    const match = configured.find((item) => item.id === id);
    if (!match) return `已删除或未知服务 · ${id.slice(0, 8)}`;
    return configured.filter((item) => item.name === match.name).length > 1
      ? `${match.name} · ${id.slice(0, 8)}`
      : match.name;
  }
  const models = useMemo(
    () =>
      [
        ...new Set(
          (data?.events ?? [])
            .filter((event) => provider === "" || event.provider === provider)
            .map((event) => event.model),
        ),
      ].sort(),
    [data, provider],
  );
  const years = [
    ...new Set((data?.events ?? []).map((event) => new Date(event.timestamp).getFullYear())),
  ]
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  const first = year ? new Date(Number(year), 0, 1) : new Date();
  if (!year) first.setMonth(first.getMonth() - 11, 1);
  first.setHours(0, 0, 0, 0);
  const last = year ? new Date(Number(year), 11, 31) : new Date();
  last.setHours(0, 0, 0, 0);
  const firstTime = first.getTime();
  const tomorrow = new Date(startOfDay(new Date()));
  tomorrow.setDate(tomorrow.getDate() + 1);
  const endTime = Math.min(
    year ? new Date(Number(year) + 1, 0, 1).getTime() : Infinity,
    tomorrow.getTime(),
  );
  const filtered = useMemo(() => {
    const now = Date.now();
    return (data?.events ?? []).filter((event) => {
      const time = Date.parse(event.timestamp);
      return (
        time >= firstTime &&
        time < endTime &&
        time <= now &&
        (provider === "" || provider === event.provider) &&
        (model === "" || model === event.model)
      );
    });
  }, [data, firstTime, endTime, provider, model]);
  const totals = filtered.reduce(
    (total, event) => ({
      input: total.input + event.input,
      output: total.output + event.output,
      cacheRead: total.cacheRead + event.cacheRead,
      cacheWrite: total.cacheWrite + event.cacheWrite,
      cost: total.cost + (event.estimatedCostUsd ?? 0),
      unknown: total.unknown + Number(event.estimatedCostUsd === null),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknown: 0 },
  );
  const grouped = new Map<number, Map<string, number>>();
  for (const event of filtered) {
    const time = startOfDay(new Date(event.timestamp));
    const group = grouped.get(time) ?? new Map<string, number>();
    group.set(event.model, (group.get(event.model) ?? 0) + event.totalTokens);
    grouped.set(time, group);
  }
  const days: [number, Map<string, number>][] = [];
  const cursor = new Date(first);
  while (cursor <= last) {
    days.push([cursor.getTime(), grouped.get(cursor.getTime()) ?? new Map()]);
    cursor.setDate(cursor.getDate() + 1);
  }
  const leadingDays = (first.getDay() + 6) % 7;
  const weeks = new Map<number, Map<string, number>>();
  const weekStart = (time: number) => {
    const date = new Date(time);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return date.getTime();
  };
  const add = (target: Map<string, number>, source: Map<string, number>) => {
    for (const [name, amount] of source) target.set(name, (target.get(name) ?? 0) + amount);
  };
  for (const [time, values] of days) {
    const key = weekStart(time);
    const week = weeks.get(key) ?? new Map<string, number>();
    add(week, values);
    weeks.set(key, week);
  }
  const running = new Map<string, number>();
  const cells = days.map(([time, values]) => {
    add(running, values);
    return [
      time,
      mode === "day"
        ? values
        : mode === "week"
          ? (weeks.get(weekStart(time)) ?? new Map())
          : new Map(running),
    ] as const;
  });
  const max = cells.reduce(
    (largest, [, values]) =>
      Math.max(
        largest,
        [...values.values()].reduce((a, b) => a + b, 0),
      ),
    0,
  );
  const months = days.flatMap(([time], index) => {
    const date = new Date(time);
    return date.getDate() === 1 || index === 0
      ? [{ label: `${date.getMonth() + 1}月`, column: Math.floor((index + leadingDays) / 7) + 1 }]
      : [];
  });
  return (
    <div className="usage-dashboard">
      <p className="muted">
        本地可读取的会话用量（包含归档与隐藏项目），不等同于服务商账单。时间按本地时区显示。
      </p>
      <div className="usage-controls">
        <Select
          aria-label="年份"
          value={year}
          onValueChange={(value) => {
            setYear(value);
            setLimit(25);
          }}
          options={[
            { value: "", label: "最近一年" },
            ...years.map((value) => ({ value: String(value), label: `${value}年` })),
          ]}
        />
        <Select
          aria-label="Provider"
          value={provider}
          onValueChange={(value) => {
            setProvider(value);
            setModel("");
            setLimit(25);
          }}
          options={[
            { value: "", label: "全部 Provider" },
            ...providers.map((value) => ({ value, label: providerName(value) })),
          ]}
        />
        <Select
          aria-label="模型"
          value={model}
          onValueChange={(value) => {
            setModel(value);
            setLimit(25);
          }}
          options={[
            { value: "", label: "全部模型" },
            ...models.map((value) => ({ value, label: value })),
          ]}
        />
        <button type="button" onClick={() => setVersion((value) => value + 1)} disabled={loading}>
          刷新
        </button>
      </div>
      {loading && <p role="status">正在读取用量…</p>}
      {error && <p role="alert">读取失败：{error}。请重试。</p>}
      {data && (
        <>
          {data.incomplete > 0 && (
            <p role="status">
              部分历史无法读取或用量记录无效（{data.incomplete} 处），统计可能不完整。
            </p>
          )}
          <div className="usage-cards">
            <div>
              <span>总 Token</span>
              <strong>
                {number(totals.input + totals.output + totals.cacheRead + totals.cacheWrite)}
              </strong>
            </div>
            <div>
              <span>输入 / 输出</span>
              <strong>
                {number(totals.input)} / {number(totals.output)}
              </strong>
            </div>
            <div>
              <span>缓存读取 / 写入</span>
              <strong>
                {number(totals.cacheRead)} / {number(totals.cacheWrite)}
              </strong>
            </div>
            <div>
              <span>估算费用</span>
              <strong>
                {filtered.length === totals.unknown ? "未知" : `$${totals.cost.toFixed(4)}`}
              </strong>
              {totals.unknown > 0 && totals.unknown < filtered.length && <small>部分未知</small>}
            </div>
          </div>
          <section className="settings-section">
            <div className="usage-activity-heading">
              <h2>Token 活动</h2>
              <div className="usage-modes">
                {(
                  [
                    ["day", "每天"],
                    ["week", "每周"],
                    ["cumulative", "累计总量"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={mode === value}
                    onClick={() => setMode(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="usage-calendar-wrap">
              <div className="usage-calendar-content">
                <div className="usage-calendar">
                  {leadingDays > 0 && <span style={{ gridRow: `span ${leadingDays}` }} />}
                  {cells.map(([time, values], index) => {
                    const total = [...values.values()].reduce((sum, value) => sum + value, 0);
                    const level = total && max ? Math.ceil((total / max) * 4) : 0;
                    const breakdown = [...values]
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([name, amount]) => `${name}：${amount.toLocaleString()} Token`);
                    const label = [
                      new Date(time).toLocaleDateString(),
                      `${mode === "week" ? "本范围内本周合计" : mode === "cumulative" ? "本范围内截至当日累计" : "总计"}：${total.toLocaleString()} Token`,
                      ...(breakdown.length ? breakdown : ["无用量"]),
                    ].join("\n");
                    return (
                      <Tooltip key={time} label={label}>
                        <button
                          type="button"
                          className={`usage-day usage-level-${level}`}
                          tabIndex={index === cells.length - 1 ? 0 : -1}
                          onFocus={(event) => {
                            for (const button of event.currentTarget.parentElement?.querySelectorAll(
                              "button.usage-day",
                            ) ?? [])
                              if (button instanceof HTMLButtonElement)
                                button.tabIndex = button === event.currentTarget ? 0 : -1;
                          }}
                          onKeyDown={(event) => {
                            const step = {
                              ArrowUp: -1,
                              ArrowDown: 1,
                              ArrowLeft: -7,
                              ArrowRight: 7,
                            }[event.key];
                            if (step === undefined) return;
                            const buttons = Array.from(
                              event.currentTarget.parentElement?.querySelectorAll(
                                "button.usage-day",
                              ) ?? [],
                            );
                            const current = buttons.indexOf(event.currentTarget);
                            const next =
                              buttons[Math.max(0, Math.min(buttons.length - 1, current + step))];
                            event.preventDefault();
                            if (next instanceof HTMLButtonElement) next.focus();
                          }}
                          aria-label={`${label}\n使用方向键切换日期`}
                        />
                      </Tooltip>
                    );
                  })}
                </div>
                <div className="usage-months" aria-hidden="true">
                  {months.map(({ label, column }) => (
                    <span key={column} style={{ gridColumn: column }}>
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </section>
          <section className="settings-section">
            <h2>Usage events · 用量明细</h2>
            <div className="usage-table-wrap">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>Provider</th>
                    <th>模型</th>
                    <th>输入 / 输出</th>
                    <th>缓存读取 / 写入</th>
                    <th>总 Token</th>
                    <th>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, limit).map((event: Event) => (
                    <tr key={event.id}>
                      <td>{new Date(event.timestamp).toLocaleString()}</td>
                      <td>{providerName(event.provider)}</td>
                      <td>{event.model}</td>
                      <td>
                        {number(event.input)} / {number(event.output)}
                      </td>
                      <td>
                        {number(event.cacheRead)} / {number(event.cacheWrite)}
                      </td>
                      <td>{number(event.totalTokens)}</td>
                      <td>
                        {event.estimatedCostUsd === null
                          ? "未知"
                          : `$${event.estimatedCostUsd.toFixed(4)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {limit < filtered.length && (
              <button type="button" onClick={() => setLimit((value) => value + 25)}>
                加载更多
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
