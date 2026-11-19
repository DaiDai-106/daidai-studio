# 应用契约

`src/contracts/` 定义前端、桌面进程和后端共享的数据格式与通信约定。以下文件名均相对于该目录。契约描述接口和边界，具体行为由各自的实现负责。

- `application.ts`：应用请求、响应和事件的格式与校验。
- `bridge.ts`：前端可通过 preload 调用的应用接口。
- `desktop.ts`：桌面通信通道、窗口信息和桥接接口。
- `process.ts`：桌面主进程与后端之间的内部消息。
- `capabilities.ts`：项目模式。
- `web_preview.ts`：网页预览的 IPC 通道、操作、事件和桥接接口。
- `schema.ts`：这些契约共用的基础字段与结构辅助定义。

TypeBox schema 在运行时校验跨进程数据，并推导对应的 TypeScript 类型；修改时要同时考虑调用方和接收方。`src/renderer/shared/` 则存放仅供前端使用的通用组件与样式，二者用途不同。

## 数据流与边界

renderer 通过 preload 的 `DesktopBridge` 调用应用接口和预览接口；应用请求携带方法及参数，主进程转发到独立后端，并将响应和事件转回 renderer。应用请求、结果和事件使用 TypeBox schema 校验；`object` 默认拒绝未声明字段。不同边界的具体校验与行为以调用方实现为准。

| 数据 | 主要内容 |
| --- | --- |
| `ProjectInfo` / `ConversationInfo` | 项目标识、模式和路径；会话归属、标题、模型、草稿及运行相关状态 |
| `WorkspaceInfo` / `ConversationView` | 工作区分页快照；当前会话历史、流式内容、工具状态、序号和错误；`usage` 为会话文件累计，`branchUsage` 为当前分支；历史事件可带 `eventLabel` |
| `BackendRequest` / `BackendResponse` | 主进程与后端内部消息，版本化请求携带 ID、方法和参数，响应用 ID 配对并返回结果或错误 |
| `PreviewEvent` / `PreviewBounds` | 网页实例的项目/标签身份、加载状态、导航状态和显示边界 |


## 设置持久化

模型服务和默认模型写入 `agent/settings.json`，主题及显示偏好写入 `desktop/settings.json`，不重写无关配置。`settings.update` 同时携带默认模型与桌面偏好时，先提交默认模型，再提交桌面偏好；第二步失败会明确提示部分成功，已提交部分在内存和磁盘中均保留，可重试桌面偏好。单个文件使用临时文件加重命名替换，跨文件不承诺事务。

## 运行中输入队列

`conversation.send` 的可选 `delivery` 为 `steer`（插话）或 `followUp`（完成后发送）。空闲时正常启动；运行中必须显式指定模式，否则拒绝。队列最多保留 20 条，原文、模式和图片写入同一个项目数据库的 `conversation_queue`，不另存聊天历史。`ConversationView.queuedMessages` 包含 ID、最多 1000 字符的预览、模式、图片数及投递/暂停状态；进度帧不携带排队图片。

Dai 在 Pi 当前输出和工具批次结束的边界逐条投递，插话优先，同模式按提交顺序；后续消息仅在任务准备结束时投递。不并行运行同一会话，也不自动中断正在执行的工具。已投递消息由 Pi 原生历史记录；只有进入历史或被输入扩展明确处理后，才删除队列项。

前端运行中发送默认使用 `followUp`。`conversation.promoteQueued` 按 ID 将本次运行尚未投递的消息升级为 `steer`，原地更新模式，不删除重建队列项，保留图片和原有提交顺序；已投递、已取消或已暂停的项拒绝升级。`conversation.cancelQueued` 按 ID 取消尚未投递的消息，正在投递时拒绝取消。停止、失败及重启后，未投递的项保留并暂停；`conversation.resumeQueue` 仅在空闲时明确恢复，不清除编辑中的草稿。开启其他新任务不会自动恢复此前暂停的项。

队列表和 Pi JSONL 不是跨文件事务：在 Pi 已写入用户消息、队列项尚未删除时崩溃，恢复列表可能残留已投递项；因此重启不自动重发，用户应核对历史后再继续或取消。

## 验收

`tests/contracts/application.test.ts` 覆盖请求、响应和事件契约；桌面桥接及预览另见 [桌面进程](desktop.md#验收)和 [Coding 工作区](design/coding_workspace.md#验收)。增删字段时同时核对发送、接收及运行时校验；测试存在不代表当前运行已通过。

`workspace.get.busyConversationIds` 返回所有运行中（含初始化）的会话 ID，与当前选中会话无关；启动、初始化失败及结束时推送工作区变更。会话视图仍按 ID 获取，客户端只接收当前选中会话的历史和进度，不混合后台会话的内容。

## 本地用量概览

`usage.dashboard` 读取仍由应用管理的 Coding 会话 JSONL（含隐藏项目和归档），不读取已删除会话的孤儿文件；返回时间、原始 Provider 和模型、输入、输出、缓存读写 Token 和估算费用。Pi 的 assistant/toolResult、usage、compaction、branch_summary 中可用的 usage 都计入；同一分叉谱系复制的完全相同条目只算一次。费用未知返回 null，不当作零；损坏或缺失的历史、无法追溯的分叉祖先及无效用量计入 incomplete，提示统计可能不完整。统计不是服务商账单，不包含其他客户端的调用。
