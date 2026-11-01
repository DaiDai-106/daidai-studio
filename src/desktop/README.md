# 桌面进程说明

`desktop` 是 Electron 的桌面外壳：管理窗口与操作系统能力，连接渲染界面和独立的后端进程。

- `main/index.ts`：设置应用并按顺序启动后端、资源协议和窗口。
- `main/window.ts`：创建窗口、同步主题、处理托盘与外部链接。
- `main/ipc.ts`：注册前端调用的桌面接口，检查请求来源并转发给后端。
- `main/backendProcess.ts`：启动后端进程，等待就绪并处理异常退出。
- `main/backend.ts`：关联请求和响应，并转发后端事件。
- `main/quit.ts`：退出前等待草稿保存，再关闭后端和托盘。
- `main/paths.ts`、`resources.ts`、`tray.ts`、`zoom.ts`：各自管理数据目录、场景资源、托盘与缩放。
- `preload/index.ts`：向前端显式开放有限的桌面接口。

普通调用经过「前端 → preload → 主进程 → 后端进程」。窗口关闭时应用通常留在托盘；真正退出时先保存前端草稿，再等待后端清理。
