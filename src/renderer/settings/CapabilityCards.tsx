import { Icon } from "../components/Icon.tsx";
import type { McpServer, Skill } from "../types.ts";
import { modeLabel } from "../workbench/modes.ts";
import { Toggle } from "./SettingsControls.tsx";

interface Actions {
  scopeLabel: string;
  onToggle: () => void;
  onEdit: () => void;
  onRemove?: () => void;
}

export function SkillCard({
  skill,
  scopeLabel,
  onToggle,
  onEdit,
  onRemove,
}: Actions & { skill: Skill }) {
  return (
    <article className="service-card" aria-label={skill.name}>
      <div className="service-heading">
        <span className="service-icon">
          <Icon name="book" size={18} />
        </span>
        <div>
          <h3>{skill.name}</h3>
          <p className="muted">
            {scopeLabel} · {skill.modes.map(modeLabel).join("、")}
            {skill.builtin && " · 内置"}
          </p>
        </div>
        {skill.automatic ? (
          <span className="muted">{skill.body ? "随模式加载" : "技能文件缺失"}</span>
        ) : (
          <Toggle label={`启用 ${skill.name}`} checked={skill.enabled} onChange={onToggle} />
        )}
      </div>
      <p className="skill-description">{skill.description}</p>
      <div className="service-actions">
        <button type="button" className="text-button" onClick={onEdit}>
          {skill.builtin ? "查看技能" : "编辑技能"}
        </button>
        {onRemove && (
          <button type="button" className="text-button" onClick={onRemove}>
            移除
          </button>
        )}
      </div>
    </article>
  );
}

export function McpServerCard({
  server,
  scopeLabel,
  onToggle,
  onEdit,
  onRemove,
}: Actions & { server: McpServer }) {
  return (
    <article className="service-card" aria-label={server.name}>
      <div className="service-heading">
        <span className="service-icon">
          <Icon name="server" size={18} />
        </span>
        <div>
          <h3>{server.name}</h3>
          <p className="muted">
            {scopeLabel} · {server.builtin ? "内置" : server.transport} ·{" "}
            {server.modes.map(modeLabel).join("、")}
          </p>
        </div>
        <Toggle label={`启用 ${server.name}`} checked={server.enabled} onChange={onToggle} />
      </div>
      <p className="skill-description">
        {server.description ?? "用户配置的 MCP 连接；实际工具由服务发现。"}
      </p>
      <p className="capability-status">
        {!server.enabled
          ? "已停用配置"
          : server.builtin
            ? server.available
              ? `已加载 · ${server.tools?.length ?? 0} 项工具`
              : "原生模块尚未安装"
            : "已保存 · 调用时连接"}
      </p>
      <div className="service-actions">
        <button type="button" className="text-button" onClick={onEdit}>
          {server.builtin ? "查看工具与接口" : "配置与工具"}
        </button>
        {onRemove && (
          <button type="button" className="text-button" onClick={onRemove}>
            移除
          </button>
        )}
      </div>
    </article>
  );
}
