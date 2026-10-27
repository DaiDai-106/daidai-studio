import { useState } from "react";
import type { ProviderInfo } from "../../shared/application.ts";
import type { McpInspection } from "../../shared/capabilities.ts";
import type { AppInfo } from "../../shared/desktop.ts";
import { BrandIcon } from "../components/BrandIcon.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Icon } from "../components/Icon.tsx";
import { Select } from "../components/Select.tsx";
import type { McpServer, Project, Skill, Theme } from "../types.ts";
import { AiSettings } from "./AiSettings.tsx";
import { SettingRow, Toggle } from "./SettingsControls.tsx";
import { ShortcutsSettings } from "./ShortcutsSettings.tsx";
import { ToolsSettings } from "./ToolsSettings.tsx";

const pages = [
  { id: "general", label: "常规", icon: "sliders", group: "偏好", keywords: "外观 主题 语言" },
  { id: "shortcuts", label: "快捷键", icon: "keyboard", group: "偏好", keywords: "键盘 操作" },
  { id: "ai", label: "AI 设置", icon: "model", group: "能力", keywords: "模型 服务 登录 账号" },
  { id: "tools", label: "工具与技能", icon: "tool", group: "能力", keywords: "MCP Skills 命令" },
  { id: "data", label: "本地数据", icon: "archive", group: "系统", keywords: "归档 记录 存储" },
  { id: "about", label: "信息", icon: "info", group: "系统", keywords: "版本 诊断" },
] as const;
export type SettingsPage = (typeof pages)[number]["id"];
interface Props {
  page: SettingsPage;
  onPage: (page: SettingsPage) => void;
  onBack: () => void;
  info: AppInfo | undefined;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  showThinking: boolean;
  onShowThinking: (value: boolean) => void;
  providers: ProviderInfo[];
  defaultModel: string;
  onProviders: () => void;
  onDefault: (id: string) => void;
  servers: McpServer[];
  skills: Skill[];
  onServers: (items: McpServer[]) => Promise<boolean>;
  onSkills: (items: Skill[]) => Promise<boolean>;
  onInspect: (server: McpServer, projectId: string) => Promise<McpInspection>;
  onCancelInspection: (id: string) => Promise<unknown>;
  project: Project | undefined;
  projects: Project[];
  onArchives: () => void;
}

export function SettingsView(props: Props) {
  const [search, setSearch] = useState("");
  const [diagnostics, setDiagnostics] = useState(false);
  const filtered = pages.filter((page) =>
    `${page.label} ${page.keywords}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="settings-layout">
      <aside className="settings-sidebar">
        <div className="settings-brand">
          设置<span>Dai</span>
        </div>
        <label className="settings-search">
          <Icon name="search" size={17} />
          <input
            aria-label="搜索设置"
            placeholder="搜索设置…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <nav aria-label="设置分类">
          {filtered.map((page, index) => (
            <div key={page.id}>
              {page.group !== filtered[index - 1]?.group && (
                <div className="section-caption">{page.group}</div>
              )}
              <button
                type="button"
                className={`settings-nav-item ${props.page === page.id ? "selected" : ""}`}
                aria-current={props.page === page.id ? "page" : undefined}
                onClick={() => props.onPage(page.id)}
              >
                <Icon name={page.icon} />
                {page.label}
              </button>
            </div>
          ))}
          {!filtered.length && <p className="small muted">没有匹配的设置分类。</p>}
        </nav>
        <button type="button" className="back-button" onClick={props.onBack}>
          <Icon name="back" size={16} />
          返回工作台
        </button>
      </aside>
      <main className="settings-main">
        <header className="topbar">
          <span className="workbench-title">设置</span>
        </header>
        <div className="settings-content">
          <div className="settings-content-inner">
            <h1 className="settings-page-title">
              {pages.find((page) => page.id === props.page)?.label}
            </h1>
            {props.page === "shortcuts" && <ShortcutsSettings />}
            {props.page === "general" && (
              <>
                <section className="settings-section">
                  <h2>外观</h2>
                  <SettingRow title="主题">
                    <Select
                      aria-label="主题"
                      value={props.theme}
                      onValueChange={props.onTheme}
                      options={[
                        { value: "system", label: "跟随系统" },
                        { value: "light", label: "浅色" },
                        { value: "dark", label: "深色" },
                      ]}
                    />
                  </SettingRow>
                  <SettingRow title="语言">
                    <Select
                      aria-label="语言"
                      value="zh-CN"
                      options={[{ value: "zh-CN", label: "简体中文" }]}
                    />
                  </SettingRow>
                </section>
                <section className="settings-section">
                  <h2>工作台</h2>
                  <SettingRow
                    title="显示思考摘要"
                    description="显示模型公开返回的思考文字，不改变模型的推理模式。"
                  >
                    <Toggle
                      label="显示思考摘要"
                      checked={props.showThinking}
                      onChange={() => props.onShowThinking(!props.showThinking)}
                    />
                  </SettingRow>
                  <SettingRow
                    title="按模式组织界面"
                    description="通用对话使用主聊天区；场景搭建在中央展示场景，聊天位于右侧。"
                  />
                  <SettingRow
                    title="对话与当前 STEP"
                    description="STEP 关联按对话保存，同项目下的对话可以选择同一文件，聊天上下文独立。关联会在重启后恢复。"
                  />
                  <SettingRow
                    title="设置保留当前现场"
                    description="打开设置不会清空场景或聊天草稿。返回工作台后继续操作。"
                  />
                </section>
                <section className="settings-section">
                  <h2>本地记录</h2>
                  <SettingRow
                    title="项目与设置会保留"
                    description="聊天、AI、MCP 与技能配置保存在本机；项目源文件保留在用户选择的目录中。"
                  />
                </section>
              </>
            )}
            {props.page === "ai" && (
              <AiSettings
                providers={props.providers}
                defaultModel={props.defaultModel}
                onProviders={props.onProviders}
                onDefault={props.onDefault}
                secureStorage={props.info?.secureStorage ?? false}
              />
            )}
            {props.page === "tools" && (
              <ToolsSettings
                servers={props.servers}
                skills={props.skills}
                project={props.project}
                projects={props.projects}
                onServers={props.onServers}
                onSkills={props.onSkills}
                onInspect={props.onInspect}
                onCancelInspection={props.onCancelInspection}
              />
            )}
            {props.page === "data" && (
              <>
                <section className="settings-section">
                  <h2>数据归属</h2>
                  <SettingRow title="应用数据目录" description={props.info?.dataRoot ?? "读取中"} />
                  <SettingRow
                    title="项目源文件"
                    description="由用户选定的本地项目目录管理，可包含任意内容；STEP 只从项目内选择。"
                  />
                  <SettingRow
                    title="聊天记录"
                    description={`${props.info?.dataRoot ?? "读取中"}/app.sqlite · 单一共享 SQLite，由 durable 管理。`}
                  />
                  <SettingRow
                    title="项目资源"
                    description="STEP 和其他本地资源保留在项目目录中，导入工具结果可在聊天中查看。"
                  />
                </section>
                <section className="settings-section">
                  <h2>历史管理</h2>
                  <SettingRow
                    title="已归档对话"
                    description="归档可恢复；删除后无法从应用恢复。两者都暂留底层历史，不释放磁盘空间，项目文件与共享场景保留。"
                  >
                    <button type="button" onClick={props.onArchives}>
                      查看已归档对话
                    </button>
                  </SettingRow>
                </section>
              </>
            )}
            {props.page === "about" && (
              <>
                <div className="about-brand">
                  <BrandIcon size={76} />
                  <h2>Dai</h2>
                  <p>面向本地项目的 AI 工作台</p>
                </div>
                <SettingRow title="版本" description={props.info?.version ?? "应用信息读取中"} />
                <SettingRow title="许可证" description="UNLICENSED · 详见项目授权说明" />
                <SettingRow
                  title="诊断"
                  description="先查看收集范围，不包含凭据、聊天或项目文件内容。"
                >
                  <button type="button" onClick={() => setDiagnostics(true)}>
                    查看诊断范围
                  </button>
                </SettingRow>
                <p className="small muted about-note">
                  本地模型工作台 · CAD 工具与技能按项目和模式加载。
                </p>
              </>
            )}
          </div>
        </div>
      </main>
      {diagnostics && (
        <Dialog title="诊断信息预览" onClose={() => setDiagnostics(false)}>
          <p>仅显示应用名称、版本和运行时版本，不读取密钥、配置、聊天或文件。</p>
          <pre className="diagnostic-output">
            {JSON.stringify(props.info ?? { status: "应用信息不可用" }, null, 2)}
          </pre>
          <p className="small muted">此页面未发送或导出任何信息。</p>
        </Dialog>
      )}
    </div>
  );
}
