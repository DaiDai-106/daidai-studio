# 后端与数据

本文记录后端架构和数据边界；具体实现与验收以工作树和测试结果为准。页面交互见 [前端设计](frontend.md)。

## 职责与装配

```text
React 界面
  ↕ 受控 IPC 与事件
Electron 主进程（窗口、系统选择器）
  ↕
Node 后端
  ├─ 项目、会话、模型与设置
  ├─ Pi Agent SDK：历史、模型、内置工具、Extension 与 Skill
  └─ package/Skill 管理
       └─ 第三方 Pi package：可提供 Extension 和 Skill
```

Electron 主进程处理窗口、操作系统文件选择以及受控 IPC；独立 Node 后端处理项目、会话、模型和 package。后端以 Pi Coding Agent SDK 创建 Coding 会话，装配用户和启用包中的 Skill。

Pi 会话拥有对话历史，Dai 保存项目索引、草稿和模型选择。`src/contracts` 约定实际跨进程请求、响应和事件。

`src/contracts/request_policy.ts` 为每个命令声明调度策略。读取和中断响应绕过写入队列，模型目录查询也可独立执行。普通修改串行排队，等待超时的修改会在执行前取消；已开始的修改返回实际结果。发送消息在初始化并提交后返回，模型生成继续异步运行。同一会话的运行记录管理队列、输出和结束清理，查看空会话只读取历史，发送时才绑定会话文件。

仓库主要目录的职责如下：

```text
src/desktop/        Electron 主进程和 preload
src/renderer/       React 页面、聊天、项目、设置
src/backend/
  agent/            Pi 会话、工具适配与授权
  coding/           项目文件、引用与 Git 只读服务
  extensions/       Package、Skill 服务与请求处理
  projects/         项目与会话元数据存储
  settings/         模型提供方、认证和应用设置
src/contracts/      实际跨进程请求、响应及事件
src/shared/         跨层纯逻辑；node/ 仅供 Node 进程使用的文件访问
modules/scene/      独立 STEP 解析工具和 OCCT 构建配置
resources/icons/    桌面图标
scripts/            构建辅助脚本
tests/              测试入口、契约、后端和 Electron 测试
```

项目、设置、凭据和 Pi 会话各有明确的存储与恢复职责。不支持或迁移旧架构数据；过期的项目数据库在建表前明确拒绝，不自动补列或改写，用户需使用新数据目录。当前格式的会话恢复、凭据保存和场景撤销继续支持；Pi 会话读写直接复用当前 SDK，不增加旧格式适配层。Dai 不装配 MCP 连接器。

Pi 依赖固定为 `1.6.0`（`pi-ai`、`pi-coding-agent` 同步升级）。模型目录、基础工具和会话历史复用 Pi；项目身份、桌面交互、访问审批由 Dai 管理。Pi 1.5 的模型推理档 schema 使用 pi-schema，应用 IPC 仍使用 TypeBox：契约从 Pi 的 `MODEL_THINKING_LEVELS` 构造本地 TypeBox 枚举，避免两套取值手工漂移。Pi 的终端渲染和交互功能不会自动替代 Electron 界面。1.6 的只读 TUI 渲染数组变更不涉及桌面组件；`find` 的带目录 glob 相对于搜索目录匹配，跨层搜索需显式使用 `**/`，仍经过 Dai 的文件访问校验。

原生模型目录升级后，已保存但无法解析的型号在 `ProviderInfo.unavailableModels` 中标记；此状态只随响应返回，不写入配置。界面保留旧型号并提示重新选择，失效型号不进入聊天和默认模型候选，调用时返回明确错误。配置、凭据和仍被配置引用的默认选择不会因目录变化或添加服务而自动替换；用户可停用失效服务，或编辑型号后复用已有凭据。

## 桌面进程

`src/desktop/main/index.ts` 按顺序启动后端和窗口。`window.ts` 管理窗口、同步主题和处理外部链接，`paths.ts`、`tray.ts` 和 `zoom.ts` 分别管理数据目录、托盘和缩放。`ipc.ts` 检查请求来源并转发普通应用请求，项目目录和 Skill 选择由主进程处理。渲染进程通过 `src/desktop/preload/index.ts` 暴露的 `DesktopBridge` 访问这些能力。

`backend_process.ts` 启动后端、等待就绪并处理异常退出，`backend.ts` 校验响应与事件，并用请求 ID 配对结果。查询和写入排队的等待上限为 30 秒，后端退出时主进程拒绝仍在等待的调用。关闭窗口通常隐藏到托盘，应用退出时由 `quit.ts` 协调草稿保存、后端清理与托盘关闭。Linux 用设备号和 inode 将桌面主进程和后端绑定到同一数据目录。

网页预览按项目和标签身份隔离。`browser/controller.ts` 和 `browser/ipc.ts` 管理视图、矩形、生命周期和请求，`urls.ts` 与 `static_server.ts` 限制预览来源及项目内 HTML 的静态资源。初始化中的标签也计入数量上限。关闭标签或销毁窗口时取消未完成的初始化，取消标记只保留到初始化结束。浏览器通过后端确认项目身份，文件与 Git 由 `src/backend/coding/` 处理，共用的目录句柄和限量读取逻辑位于 `src/shared/node/file_access.ts`。 [Coding 工作区](coding_workspace.md#安全与平台边界)

## 核心数据与请求流程

| 数据 | 所有权与主要字段 |
| --- | --- |
| 项目 | `projects.sqlite` 的 `projects` 表：ID、名称、模式、目录、创建时间和隐藏状态；ID 是隔离边界 |
| 会话 | `conversations` 表：项目 ID、标题、模型、草稿、归档、Pi 会话文件、推理档、访问模式及中断状态；消息历史由 Pi JSONL 保存 |
| 工作区快照 | `workspace.get` 返回设置、项目、分页会话、游标、数据根和待处理交互；会话详情另由 `conversation.watch` 读取 |

请求从 renderer 经 preload 和 Electron 主进程进入后端；主进程用请求 ID 配对响应并转发事件。后端校验参数并根据策略调度，返回结果；前端通过事件与重新读取更新投影。应用契约及内部协议的边界见 [应用契约](../contracts.md)。

## 聊天推送与历史投影

会话历史仍由 Pi SessionManager 保存。`agent/history_projection.ts` 按 SessionManager 和分支叶节点缓存界面投影，追加或切换分支后重建；模型配置失效时清空缓存。连续流式片段在 50 ms 窗口内合并，通过 `conversation.progress` 发送当前回复和工具状态，不重复传输 `messages`。历史提交、工具开始/结束和运行终态仍发送完整 `conversation` 快照，并取消待发送的进度帧。

完整快照和进度帧共享流 ID、递增序号及 `historyKey`。前端只在分支身份一致时把进度合并到已有历史；初次打开通过 `conversation.watch` 获取完整状态。停止或最终失败必须立即进入终态，不能被迟到片段覆盖。

## 用量、原生记录与项目指令

`ConversationView.usage` 表示当前 Pi 会话文件全部分支的已记录用量，`branchUsage` 表示当前分支用量；单次回复仍使用该回复自身的用量。累计包括 assistant、工具、压缩/分支摘要及独立 usage 条目；分叉文件中的继承记录计入，未记录的消耗无法还原。已加载 Agent 使用 `getSessionStats()`，未加载时从 `SessionManager.getEntries()` 按相同口径统计，不为查看历史创建 Agent 或要求配置模型。未知价格保留为未知；统计与历史一起缓存，不随每个流式片段重算。

历史通过 Pi 的 `sessionEntryToContextMessages()` 转换条目，再适配界面。保留压缩前的历史，同时展示压缩摘要、分支摘要及 `display: true` 的扩展消息；隐藏扩展消息、扩展私有状态和系统提示不展示。模型上下文仍由 Pi 构建，不能用压缩后的上下文直接替换完整聊天记录。

Coding 创建 Agent 时启用 Pi 的项目指令发现：按上游规则读取工作目录及祖先目录的 `AGENTS.md` / `CLAUDE.md`，全局指令目录使用 Dai 数据根下的 `agent/`。这些内容作为指令加载，不扩大文件工具授权。指令在 Agent 资源加载时读取，不是实时文件监听。项目 `.pi` 扩展和 Skill 的自动发现仍关闭，相关资源继续由 Dai 管理。

## 项目和会话

创建 Coding 项目时选择名称和可选工作目录；不选时在系统 Documents 下的 `Dai/` 创建目录。不要求 Git，也不在项目目录写 `.dai/`。项目 ID 是持久身份，多个项目可指向同一目录；目录不可用时提示错误。当前最多同时显示 100 个未隐藏项目。

项目包含多个会话；普通新建会话拥有独立历史，从已有会话分叉可继承分叉点历史，随后独立。Pi `SessionManager` 是会话历史权威来源；产品元数据保存空会话、草稿和历史文件路径，不维护可独立更改的第二份消息真相。已有消息的历史文件丢失时，打开会报错，不会静默创建空历史；删除会话移除数据库记录，当前实现不删除对应 JSONL 文件。不同项目即使 cwd 相同也不能以 cwd 合并会话。关闭重启后用户选中会话时恢复该会话；中断的副作用不自动重放。

应用启动只加载列表和配置等轻量信息，选中会话时读取历史；交互响应和停止通道不能排在等待其结果的任务之后。

## 存储、文件与提交

聊天数据、项目索引、模型配置和 Skill 默认位于 `~/.dai/` 或配置的数据根。`projects.sqlite` 保存项目和会话元数据；Pi 历史位于 `agent/sessions/<项目 ID>/`，用户 Skill 位于 `agent/skills/`，模型设置和凭据分别保存在 `agent/settings.json` 与 `agent/auth.json`。旧场景和机器人项目不会显示，数据库及原有文件不会自动删除。



## 凭据和扩展边界

模型 provider、登录、密钥和自定义模型适配以实际 Pi SDK 能力验证。模型设置保存在数据根的 `agent/settings.json`，模型凭据保存在 `agent/auth.json`，内容不加密；不将密钥写入普通配置、进程参数、聊天或日志。Pi 默认资源和设置发现需受控，不能意外访问 `~/.pi` 或项目 `.pi` 来绕开 Dai 的存储及 package 规则。

第三方能力通过 Pi package 导入。配置、凭据注入和包来源追踪是宿主能力，Pi package 格式本身不保证自动实现，见 [Package 与 Skill](packages.md)。

## Pi 基础文件工具的范围

每个会话独立保存访问权限，新建和分叉默认“请求批准”。此模式下 Bash 和 PowerShell 每次执行前请求批准；Pi 的 read、write、edit、ls、find 和 grep 做工具级路径校验：允许项目目录，读取另行允许已加载 Skill 的目录。切换为“完全访问”后，命令不再逐次确认，基础文件工具也不再受项目路径限制，仍受当前用户的系统权限约束。运行中的会话不能切换权限。

基础文件工具通过解析真实路径进行调用前检查，并非目录句柄级隔离；工具级检查不是第三方 Pi Extension 或经用户确认的 shell 的进程沙箱。

## 验收

- `tests/backend/projects/store.test.ts` 和 `tests/backend/application_workflow.test.ts` 覆盖项目、会话存储及应用工作流。
- `tests/backend/agent/pi_history.test.ts`、`history_projection.test.ts`、`streaming.test.ts` 和 `concurrency.test.ts` 覆盖历史、流式投影及会话并发；`file_access.test.ts`、`shell_approval.test.ts` 覆盖工具路径与命令确认。以上文件后缀均为 `.test.ts`，具体路径在 `tests/backend/agent/`。
- `tests/integration/native_history_ui.test.ts` 验证未配置模型时恢复摘要、扩展消息及跨分支用量；`tests/backend/agent/pi_agent.test.ts` 验证项目指令发现与资源隔离、SDK 统计和恢复统计一致。
- `tests/contracts/application.test.ts` 验证应用契约；执行环境与测试结果要求见 [测试与验收](testing.md)。测试存在不代表当前工作树已通过。
- `tests/integration/desktop.test.ts`、`tests/desktop/project_directory.test.ts` 和 `tests/integration/shell_desktop.test.ts` 验证窗口、目录选择和桌面 Shell 流程。网页预览与 TLS 测试见 [Coding 工作区](coding_workspace.md#验收)。Electron 测试需要图形环境，其他平台需实际验证。
