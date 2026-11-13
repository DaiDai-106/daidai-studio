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

场景首次使用需要 Python 3.12、pip 和网络，可在界面中安装场景 Python 环境。几何处理使用项目级 Runtime 调用 Python worker；Python 的第三方几何依赖包含原生二进制。包和各平台依赖的说明见 [场景 Runtime](spec/scene_runtime_guide.md)。

Coding 工作区提供中间 AI 对话、右侧可收起的文件、差异和网页标签。网页支持 HTTPS（例如直接输入 `google.com`）、本机 HTTP 服务及项目内 HTML；HTTPS 使用系统网络和默认 TLS 校验，登录等页面能力仍取决于站点。工作区提供文件路径搜索、只读代码高亮和 Git 差异。会话列在左侧所属项目下，按首条消息自动命名；各模块均可返回项目主页。聊天输入 `@` 选择项目文件，可指定行范围；引用显示为可移除的标签，随草稿保存，发送时读取并记录真实内容快照，历史快照默认折叠。文件和差异标签、面板布局按项目恢复；网页会话不持久化。聊天的相对文件链接及行内代码路径可打开到工作区并定位行号。Git 变更查看支持区分已暂存、未暂存及未跟踪文件；代码编辑不在当前范围。文本文件限制为 2 MiB，高亮和未跟踪文件差异有更低的性能上限。受控文件与 Git 访问目前仅支持 Linux，其他系统会提示不可用。

在「设置 → AI 设置」配置模型；创建场景项目后选择 STEP。项目内多个会话共享该项目的场景，但聊天历史独立；从已有会话分叉可以继承分叉点的历史。应用启动时不会预加载所有项目场景，打开项目后才恢复该项目的视图。

## 扩展与技能

外部扩展采用 Pi package 格式，可从本地目录、npm 或 Git 安装；一个包可提供 Extension、工具或 Skill，并可在包内注册第三方 MCP 服务。Dai 不提供独立 MCP 服务配置。不同项目模式使用各自的提示词，场景模式额外加载内置场景 Skill；用户 Skill 和启用的包内 Skill 可供各模式使用。用户可以管理自己的 Skill，包内 Skill 默认只读。第三方扩展在宿主进程执行，文件工具的路径检查不构成扩展进程沙箱。

## 代码导航

- `src/backend/`：应用装配；`agent/` 管理会话，`projects/` 管理元数据，`scene/` 管理场景服务与 Python，`coding/` 提供文件与 Git 读取，`extensions/` 管理 Package 和 Skill。
- `src/desktop/`：Electron 窗口、IPC、网页预览和系统能力。
- `src/renderer/`：`app/` 组合应用，`features/` 按业务组织界面，`shared/` 放通用组件。小功能平铺，较大功能再分组件、逻辑与样式。
- `src/contracts/` 定义跨进程契约；`src/shared/` 放跨层共用实现；`packages/` 提供 Runtime 与几何能力。
- `tests/` 按执行层和业务功能归组；`spec/design/` 按功能记录当前实现、边界与验收，未实现目标单独标明。

## 检查与打包

```bash
npm run lint
npm run lint:python
npm test
npm run test:scene
npm run package:dir
```

Python 格式检查需要先在开发环境执行 `python -m pip install -e ".[dev]"`；不需要将 Ruff 安装到应用的场景运行环境。场景专项测试需要带 OCP/VTK 的 Python，可设置 `DAI_SCENE_TEST_PYTHON` 指向解释器。测试使用临时数据与本地模型对端；具体环境、样本和未覆盖范围见 [测试与验收](spec/design/testing.md)。`package:dir` 只生成本地目录，不发布应用；跨平台构建配置不等于已在目标系统实测。

Linux 打包后可运行 `node tests/integration/package_smoke.mjs release/linux-unpacked/daidai-pi` 检查打包版；设置 `DAI_SCENE_TEST_PYTHON` 后还会验证 STEP 导入及重启恢复。

[设计文档与工程边界](spec/README.md) · [场景 Runtime](spec/design/scene_runtime.md) · [Package 与 Skill](spec/design/packages.md)
