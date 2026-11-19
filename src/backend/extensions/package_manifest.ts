import type { CatalogResource, PluginHost } from "../../contracts/catalog.ts";
import { productName } from "../../shared/app_metadata.ts";

function checkDesktopResources(resources: readonly CatalogResource[]) {
  if (resources.some((resource) => resource !== "desktop-theme"))
    throw new Error("暂不支持混合 Pi 与桌面资源的插件，请拆分为两个包。");
}

/** 目录声明用于路由；实际包仍须经过下面的清单解析与宿主校验。 */
export function resourceHost(resources: readonly CatalogResource[]): PluginHost {
  if (!resources.includes("desktop-theme")) return "pi";
  checkDesktopResources(resources);
  return "desktop";
}

/** 一次解析同时返回宿主和资源；Pi 保留约定目录发现，Desktop 必须显式声明。 */
export function packageManifest(manifest: Record<string, unknown>) {
  const pi = manifest.pi as Record<string, unknown> | undefined;
  const resources: CatalogResource[] = (
    [
      ["extensions", "extension"],
      ["skills", "skill"],
      ["prompts", "prompt"],
      ["themes", "theme"],
    ] as const
  )
    .filter(([key]) => Array.isArray(pi?.[key]) && pi[key].length > 0)
    .map(([, type]) => type);
  const dai = manifest.dai as
    | { host?: unknown; schemaVersion?: unknown; themes?: unknown }
    | null
    | undefined;
  const host: PluginHost = dai?.host === "daidai_pi" ? "desktop" : "pi";
  if (host === "desktop") {
    if (dai?.schemaVersion !== 1) throw new Error(`${productName} 桌面插件清单版本无效。`);
    checkDesktopResources(resources);
    if (dai.themes !== undefined) resources.push("desktop-theme");
  }
  return { host, resources };
}
