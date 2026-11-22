import { type Static, Type } from "typebox";
import { object } from "./schema.ts";

const CatalogSourceIdSchema = Type.Enum(["pi", "company"]);
// 市场回答“在哪里发现”，宿主回答“由谁加载”；两者始终独立。
const PluginHostSchema = Type.Enum(["pi", "desktop"]);
export type PluginHost = Static<typeof PluginHostSchema>;
const CatalogResourceSchema = Type.Enum(["extension", "skill", "prompt", "theme", "desktop-theme"]);
// 模块标识独立于项目模式，插件可预先分配到尚未开放的模块。
export const pluginModules = {
  coding: "Coding",
  scene: "场景搭建",
  robot: "机器人工作平台",
} as const;
export const PluginModuleSchema = Type.Enum(["coding", "scene", "robot"]);
export type PluginModule = Static<typeof PluginModuleSchema>;
export const PluginScopeSchema = Type.Enum(["global", "module"]);
export type PluginScope = Static<typeof PluginScopeSchema>;
// 同一来源可同时装在全局与模块，诊断必须保留实际生效的范围。
export type PackageLoad = { source: string; scope: PluginScope; error: string };
const text = (maxLength = 4096) => Type.String({ maxLength });
// 安装信息不依赖市场来源；Agent 和 Desktop 加载器共用这一只读快照。
const InstalledPackageSchema = object({
  host: PluginHostSchema,
  source: text(),
  scope: PluginScopeSchema,
  moduleId: Type.Optional(PluginModuleSchema),
  enabled: Type.Boolean(),
  installedPath: text(),
  name: text(500),
  description: text(),
  version: text(100),
  resources: Type.Array(CatalogResourceSchema, { maxItems: 5 }),
  dai: Type.Unknown(),
  manifestError: text(2000),
});
export type InstalledPackage = Static<typeof InstalledPackageSchema>;
const CatalogEntrySchema = object({
  host: PluginHostSchema,
  sourceId: CatalogSourceIdSchema,
  id: Type.String({ minLength: 1, maxLength: 500 }),
  name: text(200),
  description: text(),
  publisher: text(200),
  version: text(100),
  installSource: text(),
  resources: Type.Array(CatalogResourceSchema, { maxItems: 5 }),
  compatibility: Type.Enum(["unknown", "incompatible"]),
  compatibilityNote: text(2000),
  homepage: text(),
});
export type CatalogEntry = Static<typeof CatalogEntrySchema>;
export type CatalogSourceId = Static<typeof CatalogSourceIdSchema>;
export type CatalogResource = Static<typeof CatalogResourceSchema>;
export const CatalogOriginSchema = object({
  ...Type.Pick(InstalledPackageSchema, ["source", "host", "scope", "moduleId"]).properties,
  sourceId: CatalogSourceIdSchema,
  entryId: CatalogEntrySchema.properties.id,
  catalogUrl: Type.Optional(text(2000)),
});
export type CatalogOrigin = Static<typeof CatalogOriginSchema>;
export const CatalogDetailSchema = object({
  entry: CatalogEntrySchema,
  readme: text(100_000),
  versions: Type.Array(text(100), { maxItems: 100 }),
  notice: Type.Optional(text(2000)),
});
export type CatalogDetail = Static<typeof CatalogDetailSchema>;
const CatalogGroupSchema = object({
  sourceId: CatalogSourceIdSchema,
  entries: Type.Array(CatalogEntrySchema, { maxItems: 40 }),
  nextOffset: Type.Union([Type.Integer({ minimum: 0, maximum: 100_000 }), Type.Null()]),
  error: text(2000),
  cached: Type.Boolean(),
  fetchedAt: Type.Number({ minimum: 0 }),
});
export type CatalogGroup = Static<typeof CatalogGroupSchema>;
export const CatalogTaskSchema = object({
  host: PluginHostSchema,
  id: text(100),
  source: text(),
  moduleId: Type.Optional(PluginModuleSchema),
  scope: PluginScopeSchema,
  action: Type.Enum(["install", "update", "remove", "enable", "disable"]),
  state: Type.Enum(["running", "completed", "failed"]),
  message: text(2000),
  startedAt: Type.Number(),
});
export type CatalogTask = Static<typeof CatalogTaskSchema>;
const CatalogInstalledSchema = object({
  ...Type.Omit(InstalledPackageSchema, ["dai", "manifestError", "installedPath"]).properties,
  sourceId: Type.Enum(["pi", "company", "manual"]),
  entryId: text(500),
  loadState: Type.Enum(["waiting", "loaded", "ready", "failed", "disabled"]),
  error: text(4000),
});
export type CatalogInstalled = Static<typeof CatalogInstalledSchema>;
const sourceId = CatalogSourceIdSchema;
const moduleId = Type.Optional(PluginModuleSchema);
const scope = PluginScopeSchema;
export const catalogCommands = {
  "package.list": object({ moduleId, host: Type.Optional(PluginHostSchema) }),
  "catalog.sources": object({}),
  "catalog.search": object({
    sourceId: Type.Optional(sourceId),
    query: text(200),
    offset: Type.Integer({ minimum: 0, maximum: 100_000 }),
    refresh: Type.Optional(Type.Boolean()),
  }),
  "catalog.detail": object({ sourceId, id: text(500), refresh: Type.Optional(Type.Boolean()) }),
  "catalog.configure": object({ url: text(2000) }),
  "catalog.installed": object({ moduleId }),
  "catalog.tasks": object({}),
  "catalog.install": object({
    sourceId,
    id: text(500),
    version: text(100),
    scope,
    moduleId,
    replaceSource: Type.Optional(text()),
  }),
  "catalog.packageAction": object({
    host: Type.Optional(PluginHostSchema),
    action: Type.Enum(["install", "update", "remove", "enable", "disable"]),
    source: text(),
    scope,
    moduleId,
  }),
} as const;
export const catalogResults = {
  "package.list": Type.Array(InstalledPackageSchema, { maxItems: 2000 }),
  "catalog.sources": object({ companyUrl: text(2000) }),
  "catalog.search": Type.Array(CatalogGroupSchema, { maxItems: 2 }),
  "catalog.detail": CatalogDetailSchema,
  "catalog.configure": Type.Null(),
  "catalog.installed": Type.Array(CatalogInstalledSchema, { maxItems: 2000 }),
  "catalog.tasks": Type.Array(CatalogTaskSchema, { maxItems: 100 }),
  "catalog.install": CatalogTaskSchema,
  "catalog.packageAction": CatalogTaskSchema,
} as const;
