import { Value } from "typebox/value";
import type { Arguments } from "../../contracts/application.ts";
import {
  type CatalogDetail,
  CatalogDetailSchema,
  type CatalogEntry,
  type CatalogGroup,
  type CatalogResource,
  type CatalogSourceId,
} from "../../contracts/catalog.ts";
import type { createCatalogStorage } from "./catalog_storage.ts";
import { allowedCompanyPackage, companyCatalogUrl, readGitCatalog } from "./company_catalog.ts";
import { packageManifest, resourceHost } from "./package_manifest.ts";

const NPM = "https://registry.npmjs.org/";
const PAGE = 24;
const npmName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const message = (error: unknown) =>
  (error instanceof Error ? error.message : "操作失败。").slice(0, 2000);
const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown, max = 4096) => (typeof value === "string" ? value.slice(0, max) : "");

function safeUrl(value: unknown): string {
  try {
    const url = new URL(str(value));
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

/** 搜索摘要与单版本清单共用字段转换；宿主和资源仍由实际清单决定。 */
function npmSummary(p: Record<string, unknown>, id: string): CatalogEntry {
  const version = str(p.version, 100);
  const author = typeof p.author === "string" ? p.author : asObject(p.author).name;
  return {
    sourceId: "pi",
    host: "pi",
    id,
    name: id,
    description: str(p.description),
    publisher: str(author ?? asObject(p.publisher).username, 200),
    version,
    installSource: `npm:${id}@${version}`,
    resources: [],
    compatibility: "unknown",
    compatibilityNote: "尚未验证此版本在 Dai 中的桌面兼容性。",
    homepage: safeUrl(p.homepage) || `https://www.npmjs.com/package/${id}`,
  };
}

/** 有界读取目录元数据，不执行包代码，不将目录认证转发到其他地址。 */
async function fetchJson(url: string, limit = 4_000_000, timeout = 12_000): Promise<unknown> {
  const signal = AbortSignal.timeout(timeout);
  try {
    const response = await fetch(url, {
      signal,
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    if (!response.ok || !response.body) throw new Error(`目录服务返回 ${response.status}。`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > limit) throw new Error("目录响应过大。");
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("目录返回的 JSON 格式无效。");
    if (signal.aborted) throw new Error("目录请求超时，请重试。");
    if (error instanceof TypeError) throw new Error("无法连接目录，请检查网络与服务地址。");
    throw error;
  }
}

/** 两个市场输出相同的目录条目；这里不管理安装任务或运行时状态。 */
export function createCatalogSources({
  root,
  read,
  write,
  cached,
}: ReturnType<typeof createCatalogStorage>) {
  async function configuration() {
    const config = await read("sources.json", { companyUrl: "" });
    return { companyUrl: companyCatalogUrl(config.companyUrl) };
  }

  async function npmEntry(id: string, target = "latest"): Promise<CatalogEntry> {
    if (!npmName.test(id)) throw new Error("npm 包名无效。");
    if (target !== "latest" && !versionPattern.test(target)) throw new Error("npm 版本无效。");
    const manifest = asObject(
      await fetchJson(`${NPM}${encodeURIComponent(id)}/${encodeURIComponent(target)}`, 1_000_000),
    );
    const version = str(manifest.version, 100);
    if (manifest.name !== id || !versionPattern.test(version))
      throw new Error("包没有可安装的版本。");
    if (manifest.deprecated || (target !== "latest" && target !== version))
      throw new Error("该版本已不可用，请刷新详情。");
    const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : [];
    if (!keywords.includes("pi-package"))
      throw new Error("该包未声明 pi-package，不能作为目录条目安装。");
    return { ...npmSummary(manifest, id), ...packageManifest(manifest) };
  }

  async function npmDetail(id: string): Promise<CatalogDetail> {
    if (!npmName.test(id)) throw new Error("npm 包名无效。");
    // 单版本信息决定详情与安装是否可用；完整历史和 README 仅为补充。
    const [entry, extra] = await Promise.all([
      npmEntry(id),
      fetchJson(`${NPM}${encodeURIComponent(id)}`, 8_000_000, 6_000)
        .then(asObject)
        .catch(() => null),
    ]);
    const versions = asObject(extra?.versions);
    return {
      entry,
      readme: str(extra?.readme, 100_000),
      versions: [
        ...new Set([
          entry.version,
          ...Object.keys(versions)
            .filter((v) => versionPattern.test(v) && !asObject(versions[v]).deprecated)
            .reverse(),
        ]),
      ].slice(0, 100),
      ...(!extra
        ? { notice: "已显示最新版本。完整说明和历史版本暂不可用，可重新读取或查看项目文档。" }
        : {}),
    };
  }

  async function companyEntries(url: string): Promise<CatalogDetail[]> {
    if (!url) return [];
    const data = asObject(
      await (url.startsWith("git:") ? readGitCatalog(root, url) : fetchJson(url)),
    );
    if (data.schemaVersion !== 1 || !Array.isArray(data.packages) || data.packages.length > 1000)
      throw new Error("公司目录需要 schemaVersion: 1 和 packages 数组（最多 1000 项）。");
    const found = new Set<string>();
    return data.packages.map((raw: unknown) => {
      const { readme, ...value } = asObject(raw);
      const entry = {
        ...value,
        sourceId: "company",
        host:
          value.host ??
          resourceHost(
            Array.isArray(value.resources) ? (value.resources as CatalogResource[]) : [],
          ),
        compatibility: "unknown",
        compatibilityNote: "公司提供的插件；Dai 兼容性尚未验证。",
      };
      const detail = { entry, readme: str(readme, 100_000), versions: [value.version] };
      if (
        !Value.Check(CatalogDetailSchema, detail) ||
        !allowedCompanyPackage(detail.entry.installSource) ||
        resourceHost(detail.entry.resources) !== detail.entry.host ||
        found.has(detail.entry.id)
      )
        throw new Error("公司目录包含无效、重复或不支持的插件条目。");
      found.add(detail.entry.id);
      detail.entry.homepage = safeUrl(detail.entry.homepage);
      return detail;
    });
  }

  async function companyCatalog(refresh = false) {
    const { companyUrl } = await configuration();
    if (!companyUrl) return { data: [], at: 0, stale: false, error: "" };
    return cached(`company:${companyUrl}`, refresh, () => companyEntries(companyUrl));
  }

  async function search(input: Arguments<"catalog.search">): Promise<CatalogGroup[]> {
    const ids: CatalogSourceId[] = input.sourceId ? [input.sourceId] : ["pi", "company"];
    return Promise.all(
      ids.map(async (sourceId): Promise<CatalogGroup> => {
        const empty: CatalogGroup = {
          sourceId,
          entries: [],
          nextOffset: null,
          error: "",
          cached: false,
          fetchedAt: 0,
        };
        try {
          if (sourceId === "company") {
            const result = await companyCatalog(input.refresh);
            const entries = result.data
              .map((d) => d.entry)
              .filter((e) =>
                `${e.name} ${e.description} ${e.publisher}`
                  .toLowerCase()
                  .includes(input.query.toLowerCase()),
              );
            return {
              sourceId,
              entries: entries.slice(input.offset, input.offset + PAGE),
              nextOffset: input.offset + PAGE < entries.length ? input.offset + PAGE : null,
              error: result.error,
              cached: result.stale,
              fetchedAt: result.at,
            };
          }
          const query = new URLSearchParams({
            text: `keywords:pi-package ${input.query}`,
            size: String(PAGE),
            from: String(input.offset),
          });
          const result = await cached(`pi:${query}`, !!input.refresh, async () => {
            const data = asObject(await fetchJson(`${NPM}-/v1/search?${query}`));
            if (!Array.isArray(data.objects)) throw new Error("npm 搜索响应无效。");
            const entries: CatalogEntry[] = data.objects.flatMap((item: unknown) => {
              const p = asObject(asObject(item).package);
              const name = str(p.name, 200);
              if (
                !npmName.test(name) ||
                !Array.isArray(p.keywords) ||
                !p.keywords.includes("pi-package")
              )
                return [];
              return [npmSummary(p, name)];
            });
            await Promise.all(
              entries.map(async (entry) => {
                if (!versionPattern.test(entry.version)) return;
                try {
                  const metadata = (
                    await cached(`manifest:${entry.id}@${entry.version}`, false, async () =>
                      asObject(
                        await fetchJson(
                          `${NPM}${encodeURIComponent(entry.id)}/${encodeURIComponent(entry.version)}`,
                          500_000,
                        ),
                      ),
                    )
                  ).data;
                  try {
                    Object.assign(entry, packageManifest(metadata));
                  } catch (error) {
                    entry.compatibility = "incompatible";
                    entry.compatibilityNote = message(error);
                    return;
                  }
                  if (metadata.deprecated) {
                    entry.compatibility = "incompatible";
                    entry.compatibilityNote = "此版本已被发布者标记为弃用。";
                  }
                } catch {
                  /* 元数据不可用时保留未知类型，不阻止其他条目。 */
                }
              }),
            );
            return { entries, total: typeof data.total === "number" ? data.total : 0 };
          });
          return {
            sourceId,
            entries: result.data.entries,
            nextOffset: input.offset + PAGE < result.data.total ? input.offset + PAGE : null,
            error: result.error,
            cached: result.stale,
            fetchedAt: result.at,
          };
        } catch (error) {
          return { ...empty, error: message(error) };
        }
      }),
    );
  }

  async function detail(
    sourceId: CatalogSourceId,
    id: string,
    refresh = false,
  ): Promise<CatalogDetail> {
    const result =
      sourceId === "pi"
        ? await cached(`detail:v2:${id}`, refresh, () => npmDetail(id))
        : await companyCatalog(refresh);
    const data = Array.isArray(result.data)
      ? result.data.find((d) => d.entry.id === id)
      : result.data;
    if (!data) throw new Error("此来源中没有该插件。");
    return {
      ...data,
      ...(result.stale
        ? { notice: "无法获取最新信息，当前显示上次缓存。安装前会重新校验所选版本。" }
        : {}),
    };
  }

  return {
    search,
    detail,
    configuration,
    async configure(url: string) {
      await write("sources.json", { companyUrl: companyCatalogUrl(url) });
    },
    async resolveInstall(input: Arguments<"catalog.install">) {
      // 安装前重新读取远端条目，禁止用旧缓存批准被撤回的版本。
      const catalogUrl = input.sourceId === "company" ? (await configuration()).companyUrl : "";
      const current =
        input.sourceId === "pi"
          ? await npmEntry(input.id, input.version)
          : (await companyEntries(catalogUrl)).find((d) => d.entry.id === input.id)?.entry;
      if (!current) throw new Error("此来源中没有该插件。");
      if (current.compatibility === "incompatible") throw new Error(current.compatibilityNote);
      if (current.host === "desktop" && input.scope !== "global")
        throw new Error("桌面主题需要全局安装。");
      if (current.version !== input.version) throw new Error("该版本已不可用，请刷新详情。");
      return { entry: current, catalogUrl };
    },
  };
}
