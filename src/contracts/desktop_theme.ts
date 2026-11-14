import { type Static, Type } from "typebox";
import { object } from "./schema.ts";

// 桌面主题只提供颜色和阴影；组件结构、字体与交互由宿主维护。
export const desktopThemeColors = [
  "--surface",
  "--sidebar",
  "--subtle",
  "--hover",
  "--selected",
  "--border",
  "--text",
  "--muted",
  "--action",
  "--action-text",
  "--danger",
  "--focus-border",
  "--theme-accent",
  "--theme-accent-hover",
  "--theme-on-accent",
  "--theme-brand",
  "--theme-link",
  "--theme-composer",
  "--theme-user",
  "--theme-code",
  "--theme-inline-code",
  "--theme-inline-text",
  "--theme-selection",
  "--theme-selection-text",
  "--theme-success",
  "--theme-success-bg",
  "--theme-deletion",
  "--theme-deletion-bg",
  "--theme-backdrop",
] as const;
// 同一份契约约束变量名称、完整性和值格式，加载器无需再次逐项校验。
const color = Type.String({ pattern: "^#[0-9a-fA-F]{6}$" });
const shadow = Type.String({ maxLength: 200, pattern: "^[0-9a-fA-FpPxX#.,\\s]+$" });
const variables = object({
  ...Type.Record(Type.Enum(desktopThemeColors), color).properties,
  "--theme-backdrop": Type.String({ pattern: "^#[0-9a-fA-F]{8}$" }),
  "--shadow": shadow,
  "--popup-shadow": shadow,
});
export const desktopThemeVariables = Object.keys(variables.properties);
export const DesktopPaletteSchema = object({
  schemaVersion: Type.Literal(1),
  mode: Type.Enum(["light", "dark"]),
  variables,
});
export type DesktopTheme = {
  id: string;
  label: string;
  source: string;
  light: Static<typeof variables>;
  dark: Static<typeof variables>;
};
export type DesktopThemeState = {
  themes: DesktopTheme[];
  errors: Record<string, string>;
  selection: "none" | "available" | "missing" | "error";
};

const windowColors = object({ background: color, text: color });
export const WindowPaletteSchema = object({ light: windowColors, dark: windowColors });
export type WindowPalette = Static<typeof WindowPaletteSchema>;
