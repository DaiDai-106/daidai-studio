import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { InstalledPackage } from "../../contracts/catalog.ts";
import {
  DesktopPaletteSchema,
  type DesktopTheme,
  type DesktopThemeState,
} from "../../contracts/desktop_theme.ts";
import { object } from "../../contracts/schema.ts";

const name = Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9][a-z0-9._-]*$" });
const packageName = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$",
});
const declaration = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    host: Type.Literal("daidai_pi"),
    themes: Type.Array(
      object({
        id: name,
        label: Type.String({ minLength: 1, maxLength: 100 }),
        light: Type.String({ minLength: 1, maxLength: 1000 }),
        dark: Type.String({ minLength: 1, maxLength: 1000 }),
      }),
      { minItems: 1, maxItems: 20 },
    ),
  },
  { additionalProperties: true },
);

async function readJson(root: string, path: string): Promise<unknown> {
  if (isAbsolute(path) || path.includes("\\")) throw new Error("主题资源需要包内相对路径。");
  const target = await realpath(resolve(root, path));
  const inside = relative(root, target);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error("主题资源不能指向包外。");

  const file = await open(target, "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("主题资源必须是普通文件。");
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65_536) throw new Error("主题 JSON 超过 64 KiB。");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}

async function readPalette(root: string, path: string, mode: "light" | "dark") {
  const palette = await readJson(root, path);
  if (!Value.Check(DesktopPaletteSchema, palette) || palette.mode !== mode)
    throw new Error(`${mode} 配色格式无效。`);
  return palette.variables;
}

/** 只读取已安装包中的声明数据；不加载脚本、CSS 或 Pi 终端主题。 */
export async function readDesktopThemes(
  packages: InstalledPackage[],
  selectedId = "",
  selectedSource?: string,
): Promise<DesktopThemeState> {
  const themes: DesktopTheme[] = [];
  const errors: Record<string, string> = {};
  for (const item of packages) {
    if (
      item.host !== "desktop" ||
      !item.enabled ||
      !item.installedPath ||
      !item.resources.includes("desktop-theme")
    )
      continue;
    try {
      if (item.manifestError) throw new Error(item.manifestError);
      const root = await realpath(item.installedPath);
      if (!Value.Check(packageName, item.name) || !Value.Check(declaration, item.dai))
        throw new Error("Dai 桌面主题声明无效。");
      if (item.scope !== "global")
        throw new Error("桌面主题仅支持全局安装，请移除模块配置后重新安装。");

      const pending: DesktopTheme[] = [];
      for (const entry of item.dai.themes) {
        const id = `${item.name}:${entry.id}`;
        if (themes.some((theme) => theme.id === id) || pending.some((theme) => theme.id === id))
          throw new Error(`桌面主题 ID 重复：${id}。`);
        pending.push({
          id,
          label: entry.label,
          source: item.source,
          light: await readPalette(root, entry.light, "light"),
          dark: await readPalette(root, entry.dark, "dark"),
        });
      }
      if (themes.length + pending.length > 100) throw new Error("最多支持 100 个桌面主题。");
      themes.push(...pending);
    } catch (error) {
      errors[`${item.scope}:${item.source}`] =
        error instanceof Error ? error.message : "主题读取失败。";
    }
  }
  let selection: DesktopThemeState["selection"] = "none";
  if (selectedId) {
    selection = "missing";
    const selectedName = selectedId.slice(0, selectedId.lastIndexOf(":"));
    const item =
      packages.find((item) => item.scope === "global" && item.name === selectedName) ??
      packages.find((item) => item.scope === "global" && item.source === selectedSource);
    const failed = item
      ? item.enabled && (item.manifestError || errors[`global:${item.source}`])
      : !selectedSource &&
        packages.some((item) => item.scope === "global" && item.enabled && item.manifestError);
    // 读取失败只影响当前显示；确认停用、移除或贡献点删除后才清除选择。
    if (failed) selection = "error";
    if (themes.some((theme) => theme.id === selectedId)) selection = "available";
  }
  return { themes, errors, selection };
}
