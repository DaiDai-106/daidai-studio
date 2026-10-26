import { useState } from "react";
import type { McpInspection } from "../../shared/capabilities.ts";
import { Dialog } from "../components/Dialog.tsx";
import { Icon } from "../components/Icon.tsx";
import { Select } from "../components/Select.tsx";
import type { CapabilityScope, McpServer, Mode, Project, Skill } from "../types.ts";
import { modes } from "../workbench/modes.ts";
import { BuiltinMcpDialog } from "./BuiltinMcpDialog.tsx";
import { McpServerCard, SkillCard } from "./CapabilityCards.tsx";
import { McpDialog } from "./McpDialog.tsx";
import { SkillDialog } from "./SkillDialog.tsx";

interface Props {
  servers: McpServer[];
  skills: Skill[];
  project: Project | undefined;
  projects: Project[];
  onServers: (items: McpServer[]) => void;
  onSkills: (items: Skill[]) => void;
  onInspect: (server: McpServer, projectId: string) => Promise<McpInspection>;
  onCancelInspection: (id: string) => Promise<unknown>;
}
type Editor =
  | { type: "mcp"; item: McpServer | null; importing: boolean }
  | { type: "skill"; item: Skill | null; importing: boolean };

export function ToolsSettings(props: Props) {
  const [mode, setMode] = useState<Mode | "all">("scene");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "global" | "project">("all");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [remove, setRemove] = useState<{ type: "mcp" | "skill"; id: string; name: string } | null>(
    null,
  );
  const scopeName = (scope: CapabilityScope) =>
    scope.kind === "global"
      ? "全局"
      : `项目：${props.projects.find((project) => project.id === scope.projectId)?.name ?? "原项目"}`;
  const matches = (item: McpServer | Skill) =>
    `${item.name} ${"description" in item ? item.description : ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()) &&
    (mode === "all" || item.modes.includes(mode)) &&
    (scope === "all" ||
      (scope === "global"
        ? item.scope.kind === "global"
        : item.scope.kind === "project" && item.scope.projectId === props.project?.id));
  const servers = props.servers.filter(matches);
  const skills = props.skills.filter(matches);
  const defaults = {
    scope:
      scope === "project" && props.project
        ? { kind: "project", projectId: props.project.id }
        : { kind: "global" },
    modes: [mode === "all" ? "scene" : mode],
  } satisfies Pick<Skill, "scope" | "modes">;
  return (
    <>
      <p className="capabilities-intro">
        Skills 提供工作说明，MCP 提供真实工具。按项目与业务模式加载，工具权限独立管理。
      </p>
      <div className="tools-filters">
        <Select
          aria-label="筛选业务模式"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "all", label: "全部模式" },
            ...modes.map((item) => ({ value: item.id, label: item.label })),
          ]}
        />
        <fieldset className="segmented-control" aria-label="筛选配置范围">
          {(
            [
              { value: "all", label: "全部" },
              { value: "global", label: "全局" },
              { value: "project", label: "当前项目" },
            ] as const
          ).map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={scope === item.value}
              onClick={() => setScope(item.value)}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
        <label className="tools-search">
          <Icon name="search" size={15} />
          <input
            aria-label="搜索工具或技能"
            placeholder="搜索名称或技能描述…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <section className="settings-section capability-section" aria-labelledby="skills-heading">
        <header className="capability-section-heading">
          <div>
            <h2 id="skills-heading">
              技能 Skills <span className="count">{skills.length}</span>
            </h2>
            <p>定义业务步骤与工具使用规则，不单独授予权限。</p>
          </div>
          <div className="button-group">
            <button
              type="button"
              onClick={() => setEditor({ type: "skill", item: null, importing: true })}
            >
              导入技能
            </button>
            <button
              type="button"
              onClick={() => setEditor({ type: "skill", item: null, importing: false })}
            >
              <Icon name="plus" size={15} />
              新建技能
            </button>
          </div>
        </header>
        {skills.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            scopeLabel={scopeName(skill.scope)}
            onToggle={() =>
              props.onSkills(
                props.skills.map((item) =>
                  item.id === skill.id ? { ...item, enabled: !item.enabled } : item,
                ),
              )
            }
            onEdit={() => setEditor({ type: "skill", item: skill, importing: false })}
            {...(!skill.builtin
              ? { onRemove: () => setRemove({ type: "skill", id: skill.id, name: skill.name }) }
              : {})}
          />
        ))}
        {!skills.length && (
          <div className="tools-empty">
            <Icon name="book" size={22} />
            <p>此范围没有匹配的技能</p>
            <span>可以调整筛选条件，或添加配置。</span>
          </div>
        )}
      </section>
      <section className="settings-section capability-section" aria-labelledby="mcp-heading">
        <header className="capability-section-heading">
          <div>
            <h2 id="mcp-heading">
              MCP 工具 <span className="count">{servers.length}</span>
            </h2>
            <p>按服务管理连接，查看工具名称与用途。</p>
          </div>
          <div className="button-group">
            <button
              type="button"
              onClick={() => setEditor({ type: "mcp", item: null, importing: true })}
            >
              导入 JSON
            </button>
            <button
              type="button"
              onClick={() => setEditor({ type: "mcp", item: null, importing: false })}
            >
              <Icon name="plus" size={15} />
              添加 MCP 服务
            </button>
          </div>
        </header>
        {servers.map((server) => (
          <McpServerCard
            key={server.id}
            server={server}
            scopeLabel={scopeName(server.scope)}
            onToggle={() =>
              props.onServers(
                props.servers.map((item) =>
                  item.id === server.id
                    ? { ...item, enabled: !item.enabled, checked: false }
                    : item,
                ),
              )
            }
            onEdit={() => setEditor({ type: "mcp", item: server, importing: false })}
            {...(!server.builtin
              ? { onRemove: () => setRemove({ type: "mcp", id: server.id, name: server.name }) }
              : {})}
          />
        ))}
        {!servers.length && (
          <div className="tools-empty">
            <Icon name="server" size={22} />
            <p>此范围没有匹配的 MCP 服务</p>
            <span>可以调整筛选条件，或添加配置。</span>
          </div>
        )}
      </section>
      {editor?.type === "mcp" &&
        (editor.item?.builtin ? (
          <BuiltinMcpDialog server={editor.item} onClose={() => setEditor(null)} />
        ) : (
          <McpDialog
            server={editor.item}
            importing={editor.importing}
            project={props.project}
            defaults={defaults}
            onClose={() => setEditor(null)}
            onInspect={props.onInspect}
            onCancel={props.onCancelInspection}
            onSave={(server) => {
              props.onServers(
                props.servers.some((item) => item.id === server.id)
                  ? props.servers.map((item) => (item.id === server.id ? server : item))
                  : [...props.servers, server],
              );
              setEditor(null);
            }}
          />
        ))}
      {editor?.type === "skill" && (
        <SkillDialog
          skill={editor.item}
          importing={editor.importing}
          project={props.project}
          defaults={defaults}
          onClose={() => setEditor(null)}
          onSave={(skill) => {
            props.onSkills(
              props.skills.some((item) => item.id === skill.id)
                ? props.skills.map((item) => (item.id === skill.id ? skill : item))
                : [...props.skills, skill],
            );
            setEditor(null);
          }}
        />
      )}
      {remove && (
        <Dialog title="移除自定义配置" onClose={() => setRemove(null)}>
          <p>移除「{remove.name}」？此操作不删除项目文件和聊天历史。</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setRemove(null)}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                if (remove.type === "mcp")
                  props.onServers(props.servers.filter((item) => item.id !== remove.id));
                else props.onSkills(props.skills.filter((item) => item.id !== remove.id));
                setRemove(null);
              }}
            >
              移除配置
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
