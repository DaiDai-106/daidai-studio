import { useState } from "react";
import { Icon } from "../../../shared/components/Icon.tsx";
import { durationLabel, type ToolRowData, toolSummary } from "../logic/transcript.ts";

const phases: Record<string, string> = {
  verify_source: "核对文件版本",
  read_step: "读取 STEP",
  build_structure: "整理对象结构",
  build_display: "生成显示网格",
  triangulate: "生成显示网格",
  write_display: "写入显示资源",
  validate_resources: "校验资源",
  measure_distance: "测量零件间距",
};
const labels = {
  pending: "等待执行",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

export function ToolCall({ tool, onInteract }: { tool: ToolRowData; onInteract(): void }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(tool.displayName ?? tool.name, tool.args);
  const status =
    tool.status === "running" ? (phases[tool.phase ?? ""] ?? labels.running) : labels[tool.status];
  return (
    <section className={`tool-message ${tool.status}`} data-tool-name={tool.name}>
      <button
        type="button"
        className="process-row"
        aria-expanded={open}
        onClick={() => {
          onInteract();
          setOpen(!open);
        }}
      >
        <Icon
          name={
            tool.status === "failed"
              ? "close"
              : tool.status === "completed"
                ? "check"
                : tool.status === "stopped"
                  ? "stop"
                  : "tool"
          }
          size={14}
        />
        <span className="tool-heading">
          <span className="tool-name">
            {tool.serverName ? `${tool.serverName} · ` : ""}
            {tool.displayName ?? tool.name}
          </span>
          {summary && (
            <span
              className="tool-argument-summary"
              title={typeof tool.args?.path === "string" ? tool.args.path : summary}
            >
              {summary}
            </span>
          )}
        </span>
        <small>
          {durationLabel(tool.durationMs)} {status}
        </small>
        <Icon name="chevron" size={12} />
      </button>
      <div className="tool-body" hidden={!open}>
        <div className="tool-detail-heading">调用参数</div>
        <section aria-label="工具调用参数">
          <pre>{tool.args ? JSON.stringify(tool.args, null, 2) : "此历史记录没有可用参数。"}</pre>
        </section>
        {tool.argsTruncated && <p className="preview-note">参数预览已截断。</p>}
        {!!tool.images?.length && (
          <figure className="tool-capture">
            <figcaption>
              提供给助手的视口 · 视角{" "}
              {typeof tool.args?.view === "string" ? tool.args.view : "current"}
              {typeof tool.args?.revision === "number" ? ` · 场景版本 ${tool.args.revision}` : ""}
            </figcaption>
            <img
              src={`data:${tool.images[0]?.mimeType};base64,${tool.images[0]?.data}`}
              alt="提供给助手的场景视口截图"
            />
          </figure>
        )}
        <div className="tool-detail-heading">
          {tool.status === "failed" ? "错误结果" : "返回内容"}
        </div>
        <section aria-label="工具返回内容">
          <pre>
            {tool.output ||
              (tool.status === "running" || tool.status === "pending"
                ? "等待工具返回…"
                : "无文本返回。")}
          </pre>
        </section>
        {tool.outputTruncated && <p className="preview-note">返回预览已截断。</p>}
      </div>
    </section>
  );
}
