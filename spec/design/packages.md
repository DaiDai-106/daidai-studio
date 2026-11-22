# Package、Skill 与第三方能力

状态：当前实现与兼容边界。Dai 复用 Pi package 格式，内置 Runtime 和外部 Pi package 由宿主显式装配。相关交互见 [前端](frontend.md)，SDK 可行性见 [测试与验收](testing.md)。

插件中心设计与第一版落地边界维护在 [插件与技能中心设计](plugin_center.md)，公司目录格式见 [公司目录接入](../company_catalog.md)。

## 内置业务包

插件范围独立于项目，以 coding、scene、robot 标识模块。当前可创建 Coding 和场景搭建项目。全局资源供多个模块使用，模块资源供该模块的项目使用。场景首版使用内置场景工具，并读取包提供的技能和提示词。

## 装配与数据结构

设置界面经应用契约调用 `catalog.*` 包管理任务或 Skill handler，复用 `package_service.ts` 和 `skill_service.ts` 读写数据根。创建 Pi 会话时，宿主解析启用的 package 资源，显式传入 Extension、Skill、提示模板和主题路径。加载失败返回错误，不能将已安装视作已成功加载。

| 数据 | 当前结构和归属 |
| --- | --- |
| 已安装插件 | `CatalogInstalled` 包含独立的市场来源、宿主 `host`、作用域、启停状态、实际版本和最近加载结果；安装路径由包服务解析 |
| package 配置 | Pi 使用 `agent/packages/settings.json` 与 `agent/packages/modules/<模块 ID>/settings.json`；Desktop 使用 `desktop/packages/settings.json` 且只支持全局。各宿主的禁用状态保存在自己目录的 `disabled.json`，同宿主操作跨模块串行 |
| `ManagedSkill` | `id`、`name`、`description`、`source`（`user` / `package`）、`editable` 和包归属 `ownerSource/ownerScope`；用户 Skill 目录在 `agent/skills/` |
| 扩展询问 | 每个会话独立排队，包含请求 ID、会话 ID、类型和展示内容；响应、取消或超时结束等待 |

精确字段和校验以 `src/contracts/application.ts` 为准；包资源发现和模型会话的装配以 `src/backend/agent/pi_agent.ts` 为准。

## Desktop 插件

插件中心共用目录与包安装；运行宿主分开。Pi Agent 插件继续按 `pi` 字段交给 Agent 装配，Desktop 插件按 `dai` 字段由桌面主进程发现。当前 Desktop 贡献点只开放纯 JSON 桌面主题，不开放任意 React、CSS 或脚本注入。

Desktop 主进程通过 `package.list({ host: "desktop" })` 获取自己的安装快照，独立于公司目录与来源关联配置，在 `src/desktop/main/themes.ts` 校验全局已启用主题。前端选择和应用配色，桌面窗口同步原生颜色；Agent 后端不发现或执行 Desktop 主题。回退使用 `settings.update.expectedDesktopTheme` 在设置写入队列内比较原选择，旧发现结果不能清空用户刚保存的新主题；比较条件不落盘。

桌面主题使用独立 `desktop-theme` 资源类型，终端 `theme` 语义不变。确认停用、移除或贡献点删除后清除选择并恢复默认，重新启用不会自动切回；资源暂时不可读时回退显示并保留偏好，恢复后重新应用。Desktop 包不要求 `pi` 声明，配色使用 `palettes/` 等独立目录；Agent 只读取 `agent/packages/`，不会扫描 Desktop 安装空间。协议见插件仓库的宿主接入说明，真实界面验收见 `tests/integration/desktop_theme_ui.test.ts` 与 `desktop_theme_recovery.test.ts`。

`package_service.ts` 共用 Pi SDK 的 npm、Git、本地安装接口，分别创建 Pi 和 Desktop 管理实例。宿主由安装空间固定，清单只负责验证；`package_manifest.ts` 集中解析资源和宿主声明。Desktop 必须声明 `dai.host: "daidai_pi"` 与 `schemaVersion: 1`，普通 Pi 包仍支持无清单的约定目录。暂不支持同时声明 Pi 与 Desktop 资源的混合包，需拆成两个包；更新或重装不能自动改换宿主。手动安装由用户选择插件类型，市场安装按条目宿主路由，下载后仍验证实际清单。

两类插件共用 `catalog.*` 安装任务、进度和界面。Desktop 变更不使 Agent 会话失效，也不受正在回复的会话锁阻止；Pi 变更在修改安装内容前检查相关会话。npm 和 Git 的安装与更新先在临时安装空间校验宿主和所选版本，通过后才替换正式目录。安装、注册配置和启用在同一次包队列操作内完成。

新版不自动迁移旧的混放 Desktop 安装内容；旧版桌面插件需移除旧记录，再从原来源安装到 Desktop 空间。市场来源关联包含宿主，目录缓存不维护第二份安装清单。查询快照不会补写宿主标记或资源过滤器。

## 外部 Pi package

第三方能力以 Pi package 格式从支持的本地目录、npm 或 Git 来源安装；一个包可提供多个 Extension、工具或 Skill。Dai 不装配 Pi 的 MCP 连接器，也不读取 MCP 配置。第三方 Extension 在宿主进程运行，仍可自行运行任意代码，不能视为对协议或网络访问的强制封禁。

Pi package 是资源分发格式，不能假定任意包自动支持 Dai 的凭据、桌面交互或自定义 Runtime。Dai 需要明确用户配置和凭据如何提供给包，追踪 Extension、服务与工具的所属来源，处理同名、更新、失败和运行中停用。Extension 可在宿主进程运行代码；工具过滤不构成进程沙箱。安装、启用、会话加载和工具运行是不同状态，不能混同。

当前桌面扩展交互桥支持 `confirm`、`select`、单行 `input` 和 `notify`，会话停止或应用退出会取消等待；终端自定义组件、多行编辑器、主题与部分状态接口尚未实现或不会显示，不能宣称所有 Pi 交互扩展都已兼容。

Pi 本地目录来源可能引用原路径，移动或删除会影响加载；npm/Git 来源的具体依赖和更新按 Pi 行为验证。用户配置和敏感凭据不写包源码；移除包不静默删除用户的项目或凭据。

更新由用户显式触发，可能联网。Dai 只把选中的全局或模块安装交给 Pi 更新，校验失败会保留旧版本。本地 Git 仓库和本地 npm registry 测试覆盖安装、更新、作用域隔离及失败保留旧版本。

Pi 当前默认调用系统 `npm` 和 `git`，因此 npm/Git 来源分别需要目标系统提供对应工具；本地目录来源不需要。Electron 自带运行时不代表目标系统自动安装了 npm 或 Git。

Dai 通过 Pi 的进度回调展示安装和更新阶段。当前 Pi package 安装和更新没有接入可取消句柄；应用正常退出会等待正在进行的安装或更新完成，遇到网络或 npm 脚本长时间挂起可能延迟退出。不得声称退出能中断第三方安装；后续需要 SDK 可取消接口或可安全终止并恢复的独立安装进程。

## Skill

从用户来源及启用的 package 中发现标准 Skill 目录，向模型提供名称和说明，按需加载 `SKILL.md` 正文及资源基目录。宿主关闭默认资源发现，显式提供 Skill 路径。前端支持新建、编辑和完整目录导入；包内 Skill 默认只读。

当前实现将用户导入的 Skill **完整目录复制**到 Dai 数据根，保留原目录不变；Pi package 的本地目录来源则按 Pi 的方式引用原路径。用户 Skill 可编辑，包内有效 Skill 只读。插件中心和技能库均直接按模块查询，不依赖项目；个人技能保持全局共享。本地包安装使用绝对路径，包服务不再接收用户项目 cwd。包启停按全局或模块 ID 管理；模块配置优先于全局，资源去重遵循 Pi 原生规则。用户项目内不创建 `.dai/`。

## 验收

- `tests/backend/extensions/package_service.test.ts`、`package_git_offline.test.ts`、`package_npm_offline.test.ts` 验证来源、启停及本地安装/更新；`skill_service.test.ts` 验证用户 Skill 管理。文件路径均相对于 `tests/backend/extensions/`。
- `tests/backend/agent/extension_ui.test.ts` 和 `tests/integration/package_skill_ui.test.ts` 分别覆盖扩展询问和界面流程；真实远程认证、网络及第三方扩展兼容性仍须单独验证。运行条件见 [测试与验收](testing.md)。
