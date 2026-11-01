<p align="center"><img src="resources/icons/app.svg" width="80" alt="Dai" /></p>

<h1 align="center">Dai</h1>

Dai 是本地 AI 桌面工作台，结合 Pi Coding Agent SDK、项目级场景 Runtime 和三维视口。场景项目可导入 STEP、查看和调整对象，并在多个独立会话中共享一个持久化场景。

## 快速开始

需要 Node.js ≥22.19、npm ≥10 和图形桌面环境。

```bash
npm ci
npm run dev
```

创建项目时选择名称、模式和可选文件夹；没有选择文件夹时，在系统 Documents 下的 `Dai/` 中创建。聊天、模型配置、项目和场景数据默认放在 `~/.dai/`，也可配置其他数据根；项目目录中不会创建 `.dai/`。用户通过文件选择器或拖拽选择 STEP，源文件保留原位，不复制到数据根。文件移动后可以选择哈希一致的文件重新定位。

场景首次使用需要 Python 3.12、pip 和网络，可在界面中安装场景 Python 环境。几何处理使用项目级 Runtime 调用 Python worker；Python 的第三方几何依赖包含原生二进制。包和各平台依赖的说明见 [场景 Runtime](packages/scene/README.md)。

在「设置 → AI 设置」配置模型；创建场景项目后选择 STEP。项目内多个会话共享该项目的场景，但聊天历史独立；从已有会话分叉可以继承分叉点的历史。应用启动时不会预加载所有项目场景，打开项目后才恢复该项目的视图。

## 扩展与技能

外部扩展采用 Pi package 格式，可从本地目录、npm 或 Git 安装；一个包可提供 Extension、工具或 Skill，并可在包内注册第三方 MCP 服务。Dai 不提供独立 MCP 服务配置。不同项目模式使用各自的提示词与 Skill；用户可以管理自己的 Skill，包内 Skill 默认只读。第三方扩展在宿主进程执行，文件工具的路径检查不构成扩展进程沙箱。

## 检查与打包

```bash
npm run lint
npm run lint:python
npm test
npm run test:scene
npm run package:dir
```

Python 格式检查需要先在开发环境执行 `python -m pip install -r requirements-dev.txt`；不需要将 Ruff 安装到应用的场景运行环境。场景专项测试需要带 OCP/VTK 的 Python，可设置 `DAI_SCENE_TEST_PYTHON` 指向解释器。测试使用临时数据与本地模型对端；具体环境、样本和未覆盖范围见 [测试与验收](spec/design/testing.md)。`package:dir` 只生成本地目录，不发布应用；跨平台构建配置不等于已在目标系统实测。

Linux 打包后可运行 `node tests/integration/package-smoke.mjs release/linux-unpacked/daidai-pi` 检查打包版；设置 `DAI_SCENE_TEST_PYTHON` 后还会验证 STEP 导入及重启恢复。

[设计文档与工程边界](spec/README.md) · [场景 Runtime](spec/design/scene-runtime.md) · [Package 与 Skill](spec/design/packages.md)
