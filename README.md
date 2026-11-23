![Dai Studio](resources/icons/app.svg)

# Dai Studio

Dai Studio 是基于 Pi Coding Agent SDK 的本地桌面工作台，包含 Coding 和场景搭建。

- 按项目管理 AI 对话、消息队列和对话轨迹。
- 在 Coding 工作区浏览项目文件和查看 Git 差异。Linux 还支持预览项目内 HTML。
- 安装 Pi 插件，管理用户技能和桌面主题。

在「设置 → AI 设置 → 添加或编辑 AI 服务 → 选择模型」中，受支持的 OpenAI / OpenAI Codex 模型可单独勾选「请求 Fast」。默认关闭，保存后从下一次请求生效。Fast 可能增加费用或额度消耗，实际档位由服务端决定；自定义服务地址不提供此选项。

## 场景搭建

新建「场景搭建」项目后，可导入 STEP 装配或 URDF。在右侧查看 3D 模型和结构树、编辑连杆和关节、预览关节运动，并导出 URDF 与配套 STL。场景聊天可选择或拖入 STEP，由 Agent 导入并在成功后替换当前装配。

STEP 导入后，原始 CAD 装配保持不变，构建场景仅包含空的 base_link，画布不叠加原始模型。在「原始模型」中点选零件或勾选多个零件/装配，在下方属性区分配到已有 Link，或创建 Link 和 Joint；选择装配会包含其所有有几何的后代零件。归组按关节零位保留 CAD 位置，随后可调整父连杆、关节类型、原点、轴和限位。

两个视图编辑同一份 URDF 配置：「原始模型」用于主要搭建，「构建场景」仅显示已构建几何并支持微调。透明度默认 0%，只作用于所选零件、装配或连杆及其子级；多选可批量调整，不同值显示“混合”。同一零件的设置在两边共享并保存到项目，不改写 URDF 原材质。画布支持定位世界原点。重新分配、解除绑定和删除子树不删除原始 CAD，可撤销；旧场景可补充原始 STEP，已有零件绑定时需先解除绑定才能替换原始模型。

导入 STEP 会替换当前场景；仅导出当前构建场景，不包含未分配的原始 STEP 网格。

## 安装

Linux x64、Windows x64 和 macOS Apple Silicon 安装包见 [GitHub Releases](https://github.com/DaiDai-106/daidai-studio/releases)。

## 快速开始

从源码运行需要 Node.js ≥22.19、npm ≥10 和图形桌面环境。

```bash
npm ci
npm run dev
```

源码版导入 STEP 前需运行 `npm run build:scene`。发布版已包含解析器和运行库。 [STEP 解析器构建说明](modules/scene/README.md)

本地打包可运行 `npm run package:win` 或 `npm run package:deb`。macOS 安装包由 GitHub Actions 随版本标签发布。 [发布说明](spec/release.md)

[更新日志](CHANGELOG.md) · [详细文档](spec/README.md)
