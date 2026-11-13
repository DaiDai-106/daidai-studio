# Package、Skill 与第三方能力

状态：当前实现与兼容边界。Dai 复用 Pi package 格式，内置 Runtime 和外部 Pi package 由宿主显式装配。相关交互见 [前端](frontend.md)，SDK 可行性见 [测试与验收](testing.md)。

## 内置业务包

根目录 `packages/core` 提供通用 Runtime 管理及工具描述类型；`packages/scene` 提供场景业务及自己的 Python 实现和 Skill。只有确实有共享 Python 功能才在 core 引入相应目录，不创建空模块。其他业务包按需求增加，不为每个用户项目生成源码包。场景会话由宿主注册场景工具，工具调用场景服务；需要 Python 的计算再由服务调用项目 Runtime。距离计算的取消信号传递到 Runtime。

## 装配与数据结构

设置界面经应用契约调用 package/Skill handler；handler 使用 `package_service.ts` 和 `skill_service.ts` 读写数据根。创建 Pi 会话时，宿主解析启用的 package 资源，显式传入 Extension、Skill、提示模板和主题路径，并装配 MCP 连接器；场景工具另由宿主注册。加载失败返回错误，不能将已安装视作已成功加载。

| 数据 | 当前结构和归属 |
| --- | --- |
| `PackageInfo` | `source`、`scope`（`user` / `project`）、`enabled`、`filtered`，以及可选 `installedPath` |
| package 配置 | 数据根 `packages/settings.json` 与 `packages/projects/<项目 ID>/settings.json`；禁用状态在 `packages/disabled.json`，同数据根操作串行 |
| `ManagedSkill` | `id`、`name`、`description`、`source`（`user` / `package` / `builtin`）和 `editable`；用户 Skill 目录在 `data/skills/` |
| 扩展询问 | 每个会话独立排队，包含请求 ID、会话 ID、类型和展示内容；响应、取消或超时结束等待 |

精确字段和校验以 `src/contracts/application.ts` 为准；包资源发现和模型会话的装配以 `src/backend/agent/pi_agent.ts` 为准。

## 外部 Pi package 与 MCP

第三方能力以 Pi package 格式从支持的本地目录、npm 或 Git 来源安装；一个包可提供多个 Extension、工具或 Skill。包中 Extension 可以注册 MCP 服务，Dai 通过该包装配连接器；不提供脱离 package 直接添加 MCP 地址或命令的入口。Pi SDK 内置 MCP 连接能力需显式装配；默认 `mcp.json` 发现须隔离或受控，不能绕过上述入口。仅在包内放置 `mcp.json` 不代表服务自动注册。

Pi package 是资源分发格式，不能假定任意包自动支持 Dai 的凭据、桌面交互或自定义 Runtime。Dai 需要明确用户配置和凭据如何提供给包，追踪 Extension、服务与工具的所属来源，处理同名、更新、失败和运行中停用。Extension 可在宿主进程运行代码；工具过滤不构成进程沙箱。安装、启用、会话加载、MCP 实际连接和工具运行是不同状态，不能混同。

当前桌面扩展交互桥支持 `confirm`、`select` 和单行 `input`，会话停止或应用退出会取消等待；终端自定义组件、多行编辑器、主题与部分状态/通知接口尚未实现或不会显示，不能宣称所有 Pi 交互扩展都已兼容。

Pi 本地目录来源可能引用原路径，移动或删除会影响加载；npm/Git 来源的具体依赖和更新按 Pi 行为验证。用户配置和敏感凭据不写包源码；移除包不静默删除用户的项目、场景或凭据。旧架构配置不要求迁移。

更新由用户显式触发，可能联网。Pi 的更新可能同时作用于同来源的全局与当前项目包，跨作用域更新不是事务；某一项失败时应刷新实际状态并提示可能部分更新，不能承诺全部回滚。本地 Git 仓库及本地 npm registry 的安装、更新、隔离和单项失败已实测；远程认证、代理及真实网络尚未验证。

Pi 当前默认调用系统 `npm` 和 `git`，因此 npm/Git 来源分别需要目标系统提供对应工具；本地目录来源不需要。Electron 自带运行时不代表目标系统自动安装了 npm 或 Git。

Pi 1.5.1 的 package 更新进度可报告版本变化；Dai 当前更新接口尚未向界面展示该进度。当前 Pi package 安装和更新没有接入可取消句柄；应用正常退出会等待正在进行的安装或更新完成，遇到网络或 npm 脚本长时间挂起可能延迟退出。不得声称退出能中断第三方安装；后续需要 SDK 可取消接口或可安全终止并恢复的独立安装进程。

## Skill

从内置包和用户来源发现标准 Skill 目录，向模型提供名称和说明，按需加载 `SKILL.md` 正文及资源基目录。系统提示词按模式区分，内置场景 Skill 仅注入场景模式；用户 Skill 和当前启用的 package Skill 会注入各模式。宿主关闭默认资源发现，显式提供这些 Skill 路径。前端支持新建、编辑和完整目录导入；包内 Skill 默认只读，直接复制入口尚未实现。Skill 目录保留 frontmatter、相对路径、脚本和附件。

当前实现将用户导入的 Skill **完整目录复制**到 Dai 数据根，保留原目录不变；Pi package 的本地目录来源则按 Pi 的方式引用原路径。用户 Skill 可编辑，包和内置 Skill 只读。包启停按全局或项目 ID 管理；多个来源同名的最终优先级仍需明确。用户项目内不创建 `.dai/`。

第三方 MCP OAuth 状态与模型凭据一起保存在数据根的 `auth.json`；桌面端第三方 MCP OAuth 登录交互尚未打通，具体权限和界面能力需按扩展验证。

## 验收

- `tests/backend/extensions/package_service.test.ts`、`package_git_offline.test.ts`、`package_npm_offline.test.ts` 验证来源、启停及本地安装/更新；`skill_service.test.ts` 验证用户 Skill 管理。文件路径均相对于 `tests/backend/extensions/`。
- `tests/backend/package_mcp_workflow.test.ts`、`tests/backend/agent/extension_ui.test.ts` 和 `tests/integration/package_skill_ui.test.ts` 分别覆盖 MCP、扩展询问和界面流程；真实远程认证、网络及第三方扩展兼容性仍须单独验证。运行条件见 [测试与验收](testing.md)。
