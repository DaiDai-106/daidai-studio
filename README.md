<p align="center"><img src="resources/icons/app.svg" width="80" alt="Dai Studio" /></p>

<h1 align="center">Dai Studio</h1>

Dai Studio 是基于 Pi Coding Agent SDK 的本地 AI 编程桌面工作台。当前版本聚焦 Coding；场景和机器人模块留待后续重新设计。

## 快速开始

需要 Node.js ≥22.19、npm ≥10 和图形桌面环境。

```bash
npm ci
npm run dev
```

创建 Coding 项目时填写名称并选择可选文件夹；未选择时在系统 Documents 下的 `Dai/` 中创建。聊天、模型配置和项目数据默认放在 `~/.dai/`，Agent 数据位于 `~/.dai/agent/`。项目目录中不会创建 `.dai/`。 插件支持“全局（所有模块）”或“仅 Coding 模块”，安装时可选；同模块的项目共享插件。Pi 插件位于 `~/.dai/agent/packages/`；桌面插件仅全局生效，位于 `~/.dai/desktop/packages/`。两类插件共用 Pi 原生安装能力，配置和加载分开；手动安装时选择插件类型。旧版混放的桌面插件需移除旧记录后重新安装。


Coding 工作区提供中间 AI 对话、右侧可收起的文件、差异和网页标签。网页支持 HTTPS（例如直接输入 `google.com`）、本机 HTTP 服务及项目内 HTML；HTTPS 使用系统网络和默认 TLS 校验，登录等页面能力仍取决于站点。工作区提供文件路径搜索、只读代码高亮和 Git 差异。会话列在左侧所属项目下，按首条消息自动命名；各模块均可返回项目主页。聊天输入 `@` 选择项目文件，可指定行范围；引用显示为可移除的标签，随草稿保存，发送时读取并记录真实内容快照，历史快照默认折叠。文件和差异标签、面板布局按项目恢复；网页会话不持久化。聊天的相对文件链接及行内代码路径可打开到工作区并定位行号。Git 变更查看支持区分已暂存、未暂存及未跟踪文件；代码编辑不在当前范围。文本文件限制为 2 MiB，高亮和未跟踪文件差异有更低的性能上限。受控文件与 Git 访问目前仅支持 Linux，其他系统会提示不可用。


## 插件与技能

在「设置 → 插件与技能」浏览 Pi Catalog、配置公司目录、管理已安装插件和编辑用户技能。Pi 目录使用 npm 的 `pi-package` 数据发现包，收录与排序可能与 Pi 官网不同；公司目录支持无需目录登录的 HTTPS JSON 及使用系统 Git 凭据的 HTTPS/SSH 目录仓库，格式见 [公司目录接入](spec/company_catalog.md)。市场入口仅保留 Pi 和公司两类，共用的目录配置与 Git 索引位于 `~/.dai/catalog/`。

外部扩展采用 Pi package 格式，可从本地目录、npm 或 Git 安装；一个包可提供 Extension、工具或 Skill。用户可以管理自己的 Skill，包内 Skill 默认只读。第三方扩展在宿主进程执行，文件工具的路径检查不构成扩展进程沙箱。

## 代码导航

- `src/backend/`：`agent/` 管理会话，`projects/` 管理元数据，`coding/` 提供文件与 Git 读取，`extensions/` 管理 Package 和 Skill。
- `src/desktop/`：Electron 窗口、IPC、网页预览和系统能力。
- `src/renderer/`：`app/` 组合应用，`features/` 按业务组织界面，`shared/` 放通用组件。小功能平铺，较大功能再分组件、逻辑与样式。
- `src/contracts/` 定义跨进程契约；`src/shared/` 放跨层共用实现。
- `tests/` 按执行层和业务功能归组；`spec/design/` 按功能记录当前实现、边界与验收，未实现目标单独标明。

## 检查与打包

```bash
npm run lint
npm test
npm run package:dir
```

测试使用临时数据与本地模型对端；具体环境与未覆盖范围见 [测试与验收](spec/design/testing.md)。`package:dir` 只生成本地目录，不发布应用。

Linux 打包后可运行 `node tests/integration/package_smoke.mjs release/linux-unpacked/dai-studio` 检查打包版启动。软件包管理器会分别识别 `dai-studio` 和旧包 `daidai-pi`，两版读取同一个应用数据目录。

`master` 的 Linux x64 自动发版见 [发布说明](spec/release.md)。

[设计文档与工程边界](spec/README.md) · [Package 与 Skill](spec/design/packages.md)
