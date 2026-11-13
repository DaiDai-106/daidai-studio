# 桌面进程说明

`src/desktop/` 是 Electron 的桌面外壳，管理窗口与操作系统能力，连接渲染界面和独立的后端进程。以下相对路径均以该目录为基准。

- `main/index.ts`：设置应用并按顺序启动后端、资源协议和窗口。
- `main/window.ts`：创建窗口、同步主题、处理托盘与外部链接。
- `main/ipc.ts`：注册前端调用的桌面接口，检查请求来源并转发给后端。
- `main/backend_process.ts`：启动后端进程，等待就绪并处理异常退出。
- `main/backend.ts`：关联请求和响应，并转发后端事件。
- `main/quit.ts`：退出前等待草稿保存，再关闭后端和托盘。
- `main/paths.ts`、`resources.ts`、`tray.ts`、`zoom.ts`：各自管理数据目录、场景资源、托盘与缩放。
- `main/browser/controller.ts`、`browser/ipc.ts`：管理隔离的网页视图、生命周期和受控请求。
- `main/browser/urls.ts`、`browser/static_server.ts`：限制预览来源，并提供项目内 HTML 的受控静态资源。
- `preload/index.ts`：向前端显式开放有限的桌面接口。

普通调用经过「前端 → preload → 主进程 → 后端进程」。窗口关闭时应用通常留在托盘；真正退出时先保存前端草稿，再等待后端清理。

共用的 Node 目录句柄和有大小上限的文件读取位于 `src/shared/node/file_access.ts`，不依赖场景业务；浏览器通过后端确认项目身份，文件与 Git 业务仍由 `src/backend/coding/` 处理。

网页预览以项目和标签身份隔离；正在初始化的标签也计入数量上限。关闭标签或销毁窗口会取消未完成的初始化，取消标记仅在初始化期间保留，不累积关闭记录。

## 数据流与生命周期

renderer 只能通过 preload 暴露的 `DesktopBridge` 调用：普通应用请求经主进程转发到后端，项目目录、STEP 和 Skill 选择等桌面操作由主进程处理；网页预览使用独立桥接，见 [Coding 工作区](design/coding_workspace.md#安全与平台边界)。契约字段见 [应用契约](contracts.md)。

主进程以请求 ID 管理等待中的后端调用，校验响应和事件；普通请求等待上限为 30 秒，场景导入等待后端完成或进程退出。后端退出时拒绝尚未完成的请求。正常退出时协调前端草稿保存与后端清理；窗口关闭通常只隐藏到托盘。

| 主要数据 | 用途 |
| --- | --- |
| 请求 ID、方法和参数 | 将后端响应配对到发起调用；后台事件单独转发 |
| 数据根目录身份 | Linux 上通过设备号和 inode 绑定受控资源读取与后端场景路径 |
| 资源身份及元数据 | 主进程按项目与资源身份读取、校验场景资源，不直接信任后端文件路径 |
| 预览项目 ID、标签 ID 和矩形 | 管理原生网页实例和与界面同步的可见范围 |

## 验收

`tests/integration/desktop.test.ts`、`project_directory.test.ts`、`shell_desktop.test.ts` 覆盖桌面流程；`tests/desktop/resource_reader.test.ts` 覆盖资源读取。网页预览和 TLS 测试入口见 [Coding 工作区](design/coding_workspace.md#验收)；Electron 测试需要图形环境，其他平台需实际验证。
