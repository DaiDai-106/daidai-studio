# Dai 设计与工程规范

本目录按功能记录当前实现、数据边界和验收方式。每项事实只在对应专项文档维护；未实现目标单列，不用旧重构计划或已取消的编辑器方案描述当前能力。代码与可复现测试是最终依据。

| 文档 | 内容 |
| --- | --- |
| [前端与交互](design/frontend.md) | 前端目录、布局、交互与状态归属 |
| [Coding 工作区技术设计](design/coding_workspace.md) | 只读文件、diff、标签恢复、网页预览和权限边界 |
| [场景搭建模块](design/scene_module.md) | STEP 装配、URDF 工作区、场景文档与 Pi 工具 |
| [后端与数据](design/backend.md) | 总体架构、Electron 桌面进程、Pi Agent 与存储 |
| [Package 与 Skill](design/packages.md) | Pi package 和 Skill |
| [插件与技能中心设计](design/plugin_center.md) | 已确认设计与第一版边界：来源、视觉、Pi SDK 复用、接口和验收 |
| [测试与验收](design/testing.md) | 测试有效性与分层验收 |
| [应用契约](contracts.md) | 跨进程数据格式和通信约定 |
| [公司目录接入](company_catalog.md) | HTTPS JSON 目录格式与当前认证边界 |
| [代码规范](code_style.md) | 各语言命名、空格、可读性和检查范围 |

当前版本提供 Coding 与场景搭建项目，兼容读取两类项目的会话。旧场景及机器人项目原数据继续保留。
