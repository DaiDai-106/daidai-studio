import { useState } from "react";
import licenseText from "../../../../../LICENSE?raw";
import type { ProviderInfo } from "../../../../contracts/application.ts";
import type { AppInfo } from "../../../../contracts/desktop.ts";
import { BrandIcon } from "../../../shared/components/BrandIcon.tsx";
import { Dialog } from "../../../shared/components/Dialog.tsx";
import { Icon } from "../../../shared/components/Icon.tsx";
import { Select } from "../../../shared/components/Select.tsx";
import type { Project, Theme } from "../../../shared/logic/types.ts";
import { AiSettings } from "./AiSettings.tsx";
import { PackageSettings } from "./PackageSettings.tsx";
import { SettingRow, Toggle } from "./SettingsControls.tsx";
import { ShortcutsSettings } from "./ShortcutsSettings.tsx";
import { SkillLibrary } from "./SkillLibrary.tsx";

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
  project: Project | undefined;
  projects: Project[];
  onArchives: () => void;
}

export function SettingsView(props: Props) {
  const [search, setSearch] = useState("");
  const [diagnostics, setDiagnostics] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [packageRevision, setPackageRevision] = useState(0);
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
                    title="项目与场景"
                    description="场景搭建项目的对话共享一个场景，聊天历史各自独立。"
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
                    description="聊天、AI 和扩展包配置保存在本机；STEP 源文件保留在用户选择的位置。"
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
              />
            )}
            {props.page === "tools" && (
              <>
                <PackageSettings
                  project={props.project}
                  onChanged={() => setPackageRevision((value) => value + 1)}
                />
                <SkillLibrary key={packageRevision} project={props.project} />
              </>
            )}
            {props.page === "data" && (
              <>
                <section className="settings-section">
                  <h2>数据存储</h2>
                  <SettingRow title="应用数据目录" description={props.info?.dataRoot ?? "读取中"} />
                </section>
                <section className="settings-section">
                  <h2>历史管理</h2>
                  <SettingRow
                    title="已归档对话"
                    description="归档可恢复；删除后无法从应用恢复，项目文件与共享场景保留。"
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
                <SettingRow
                  title="许可证"
                  description="项目代码未声明开源许可证，第三方组件许可详见说明。"
                >
                  <button type="button" onClick={() => setLicenseOpen(true)}>
                    查看许可说明
                  </button>
                </SettingRow>
                <SettingRow
                  title="诊断"
                  description="先查看收集范围，不包含凭据、聊天或项目文件内容。"
                >
                  <button type="button" onClick={() => setDiagnostics(true)}>
                    查看诊断范围
                  </button>
                </SettingRow>
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
      {licenseOpen && (
        <Dialog title="项目许可与第三方声明" onClose={() => setLicenseOpen(false)} wide>
          <p>项目当前未声明开源许可证。以下为项目中的许可说明和第三方声明。</p>
          <pre className="diagnostic-output">{licenseText}</pre>
        </Dialog>
      )}
    </div>
  );
}
