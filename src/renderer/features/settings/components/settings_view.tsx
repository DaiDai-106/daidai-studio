import { useState } from "react";
import licenseText from "../../../../../LICENSE?raw";
import type { ProviderInfo } from "../../../../contracts/application.ts";
import type { AppInfo, Theme } from "../../../../contracts/desktop.ts";
import type { DesktopTheme } from "../../../../contracts/desktop_theme.ts";
import { BrandIcon } from "../../../shared/components/brand_icon.tsx";
import { Dialog } from "../../../shared/components/dialog.tsx";
import { Icon } from "../../../shared/components/icon.tsx";
import { Select } from "../../../shared/components/select.tsx";
import { AiSettings } from "./ai_settings.tsx";
import { PluginCenter } from "./plugin_center.tsx";
import { SettingRow, Toggle } from "./settings_controls.tsx";
import { ShortcutsSettings } from "./shortcuts_settings.tsx";
import { UsageDashboard } from "./usage_dashboard.tsx";

const pages = [
  { id: "general", label: "常规", icon: "sliders", group: "偏好", keywords: "外观 主题 语言" },
  { id: "shortcuts", label: "快捷键", icon: "keyboard", group: "偏好", keywords: "键盘 操作" },
  { id: "ai", label: "AI 设置", icon: "model", group: "能力", keywords: "模型 服务 登录 账号" },
  {
    id: "tools",
    label: "插件与技能",
    icon: "tool",
    group: "能力",
    keywords: "插件 市场 扩展 Skills 命令 公司 Pi",
  },
  { id: "data", label: "本地数据", icon: "archive", group: "系统", keywords: "归档 记录 存储" },
  { id: "dashboard", label: "Dashboard", icon: "axes", group: "系统", keywords: "用量 token 统计" },
  { id: "about", label: "信息", icon: "info", group: "系统", keywords: "版本 诊断" },
] as const;
export type SettingsPage = (typeof pages)[number]["id"];
interface Props {
  page: SettingsPage;
  onPage: (page: SettingsPage) => void;
  onBack: () => void;
  onHome: () => void;
  info: AppInfo | undefined;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  desktopTheme: string;
  desktopThemes: DesktopTheme[];
  desktopThemeErrors: Record<string, string>;
  desktopThemeError: string;
  onDesktopTheme: (id: string) => void;
  showThinking: boolean;
  onShowThinking: (value: boolean) => void;
  providers: ProviderInfo[];
  defaultModel: string;
  onProviders: () => void;
  onDefault: (id: string) => void;
  onArchives: () => void;
  loadUsage: () => Promise<
    import("../../../../contracts/application.ts").Results["usage.dashboard"]
  >;
}

export function SettingsView(props: Props) {
  const [search, setSearch] = useState("");
  const [diagnostics, setDiagnostics] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);
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
        <div className="settings-footer">
          <button type="button" className="settings-nav-item" onClick={props.onBack}>
            <Icon name="back" size={16} />
            返回工作台
          </button>
          <button type="button" className="settings-nav-item" onClick={props.onHome}>
            <Icon name="home" size={16} />
            返回项目主页
          </button>
        </div>
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
                  <SettingRow title="主题方案" description="安装的桌面主题会显示在这里。">
                    <Select
                      aria-label="主题方案"
                      value={props.desktopTheme}
                      onValueChange={props.onDesktopTheme}
                      options={[
                        { value: "", label: "Dai 默认" },
                        ...(props.desktopTheme &&
                        !props.desktopThemes.some((theme) => theme.id === props.desktopTheme)
                          ? [
                              {
                                value: props.desktopTheme,
                                label: "当前主题暂不可用",
                                disabled: true,
                              },
                            ]
                          : []),
                        ...props.desktopThemes.map((theme) => ({
                          value: theme.id,
                          label: theme.label,
                        })),
                      ]}
                    />
                  </SettingRow>
                  <SettingRow title="明暗模式">
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
                  {props.desktopThemeError && (
                    <p className="small muted" role="status">
                      {props.desktopThemeError}
                    </p>
                  )}
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
                    title="Coding 工作区"
                    description="在聊天中讨论代码，并在工作区查看项目文件和变更。"
                  />
                  <SettingRow title="项目与对话" description="每个项目可包含多个独立的对话。" />
                  <SettingRow
                    title="设置保留当前现场"
                    description="打开设置不会清空聊天草稿。返回工作台后继续操作。"
                  />
                </section>
                <section className="settings-section">
                  <h2>本地记录</h2>
                  <SettingRow
                    title="项目与设置会保留"
                    description="聊天、AI 和扩展包配置保存在本机，项目文件保留在原位置。"
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
              <PluginCenter
                onAppearance={() => props.onPage("general")}
                desktopThemes={props.desktopThemes}
                desktopThemeErrors={props.desktopThemeErrors}
              />
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
                    description="归档可恢复；删除后无法从应用恢复，项目文件保留。"
                  >
                    <button type="button" onClick={props.onArchives}>
                      查看已归档对话
                    </button>
                  </SettingRow>
                </section>
              </>
            )}
            {props.page === "dashboard" && (
              <UsageDashboard load={props.loadUsage} providers={props.providers} />
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
