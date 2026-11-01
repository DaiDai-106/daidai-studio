# Dai 设计与工程规范

本目录记录新版项目、会话、场景 Runtime 和扩展的设计边界。设计目标和实现状态以各专项文档、当前代码和可复现测试为准；未来能力不能当作已实现功能。

| 文档 | 内容 |
| --- | --- |
| [前端与交互](design/frontend.md) | 项目、会话、共享场景和扩展界面 |
| [后端与数据](design/backend.md) | 总体架构、目录职责、Pi Agent、项目、会话和存储 |
| [场景 Runtime](design/scene-runtime.md) | 项目 Runtime、Python 几何、场景提交和已知限制 |
| [Package 与 Skill](design/packages.md) | 内置业务包、Pi package 和 Skill |
| [测试与验收](design/testing.md) | 测试有效性与分层验收 |
| [代码规范](code-style.md) | 各语言命名、空格、可读性和检查范围 |

旧数据与旧会话不要求兼容或迁移；原 STEP 留在用户选择的位置。URDF 导出暂不设计。外部 MCP 只允许由 Pi package 提供，场景内置能力由 Runtime 管理。
