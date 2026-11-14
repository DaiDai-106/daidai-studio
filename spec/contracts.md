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


## 验收

`tests/contracts/application.test.ts` 覆盖请求、响应和事件契约；桌面桥接及预览另见 [桌面进程](desktop.md#验收)和 [Coding 工作区](design/coding_workspace.md#验收)。增删字段时同时核对发送、接收及运行时校验；测试存在不代表当前运行已通过。
