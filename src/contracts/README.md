# 应用契约

这里定义前端、桌面进程和后端共享的数据格式与通信约定。契约描述接口和边界，具体行为由各自的实现负责。

- `application.ts`：应用请求、响应和事件的格式与校验。
- `bridge.ts`：前端可通过 preload 调用的应用接口。
- `desktop.ts`：桌面通信通道、窗口信息和桥接接口。
- `process.ts`：桌面主进程与后端之间的内部消息。
- `capabilities.ts`：项目模式。
- `schema.ts`：这些契约共用的基础字段与结构辅助定义。

TypeBox schema 在运行时校验跨进程数据，并推导对应的 TypeScript 类型；修改时要同时考虑调用方和接收方。`src/renderer/shared/` 则存放仅供前端使用的通用组件与样式，二者用途不同。
