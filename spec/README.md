# Dai 设计与工程规范

本目录按功能记录当前实现、数据边界和验收方式。每项事实只在对应专项文档维护；未实现目标单列，不用旧重构计划或已取消的编辑器方案描述当前能力。代码与可复现测试是最终依据。

| 文档 | 内容 |
| --- | --- |
| [前端与交互](design/frontend.md) | 当前布局、组件与状态归属、交互及未实现范围 |
| [Coding 工作区技术设计](design/coding_workspace.md) | 只读文件、diff、标签恢复、网页预览和权限边界 |
| [后端与数据](design/backend.md) | 总体架构、目录职责、Pi Agent、项目、会话和存储 |
| [场景 Runtime](design/scene_runtime.md) | 项目 Runtime、Python 几何、场景提交和已知限制 |
| [Package 与 Skill](design/packages.md) | 内置业务包、Pi package 和 Skill |
| [测试与验收](design/testing.md) | 测试有效性与分层验收 |
| [前端目录说明](renderer.md) | 渲染界面的目录职责和开发约定 |
| [桌面进程说明](desktop.md) | Electron 外壳、桥接和网页预览 |
| [应用契约](contracts.md) | 跨进程数据格式和通信约定 |
| [场景 Runtime 使用指南](scene_runtime_guide.md) | Python 环境、部署和场景导入 |
| [代码规范](code_style.md) | 各语言命名、空格、可读性和检查范围 |

旧数据与旧会话不要求兼容或迁移；原 STEP 留在用户选择的位置。URDF 导出暂不设计。外部 MCP 只允许由 Pi package 提供，场景内置能力由 Runtime 管理。
