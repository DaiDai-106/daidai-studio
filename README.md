![Dai Studio](resources/icons/app.svg)

# Dai Studio

Dai Studio 是基于 Pi Coding Agent SDK 的本地桌面工作台，包含 Coding 和场景搭建。

- 按项目管理 AI 对话、消息队列和对话轨迹。
- 在 Coding 工作区浏览项目文件和查看 Git 差异。Linux 还支持预览项目内 HTML。
- 安装 Pi 插件，管理用户技能和桌面主题。

## 场景搭建

新建「场景搭建」项目后，可导入 STEP 装配或 URDF。在右侧查看 3D 模型和结构树、编辑连杆和关节、预览关节运动，并导出 URDF 与配套 STL。场景聊天可选择或拖入 STEP，由 Agent 导入并在成功后替换当前装配。

STEP 导入后可切换查看只读原始模型和可编辑场景。左侧「属性」显示所选对象的编辑控件，以及相对父级与世界坐标的变换。画布支持定位世界原点。
旧场景可在「原始模型」中补充原始 STEP，保留已有的场景编辑。

STEP 装配按固定关节导入。跳过的曲面会列在导入说明里，预览和导出共用同一份网格。

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
