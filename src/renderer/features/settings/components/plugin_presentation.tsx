import type { ReactNode } from "react";
import {
  type CatalogEntry,
  type CatalogInstalled,
  type PluginModule,
  pluginModules,
} from "../../../../contracts/catalog.ts";
import { Icon } from "../../../shared/components/icon.tsx";

export const sources = {
  pi: "Pi Catalog",
  company: "公司内部",
  manual: "手动安装",
};
export const resourceLabels = {
  extension: "功能扩展",
  skill: "技能",
  prompt: "提示模板",
  theme: "终端主题",
  "desktop-theme": "桌面主题",
};
export function scopeLabel(scope: CatalogInstalled["scope"], moduleId: PluginModule = "coding") {
  return scope === "global" ? "全局（所有模块）" : `仅 ${pluginModules[moduleId]} 模块`;
}
export const compatibility = {
  unknown: "未验证",
  incompatible: "不兼容",
};
const initials = (name: string) =>
  name
    .replace(/^@/, "")
    .split(/[/-]/)
    .filter(Boolean)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
export function Glyph({ name, source }: { name: string; source: string }) {
  return (
    <span className={`plugin-glyph source-${source}`} aria-hidden="true">
      {initials(name) || "P"}
    </span>
  );
}
export function ResourceTags({ entry }: { entry: Pick<CatalogEntry, "resources"> }) {
  return (
    <div className="plugin-tags">
      {entry.resources.length ? (
        entry.resources.map((r) => <span key={r}>{resourceLabels[r]}</span>)
      ) : (
        <span>未标注类型</span>
      )}
    </div>
  );
}
export function Empty({
  icon = "box",
  title,
  children,
}: {
  icon?: "box" | "search" | "tool";
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="plugin-empty">
      <span className="plugin-empty-symbol">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}
