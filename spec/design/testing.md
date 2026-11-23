# 测试与验收

`npm run lint` 检查格式与静态规则，`npm run typecheck` 检查类型，`npm test` 构建并运行测试。本地可用 `npm run check` 一次执行 lint、构建和测试，或用 `npm run package:dir` 生成本地打包目录。

后端测试覆盖项目与会话、权限、文件和 Git 访问、Pi package 与用户 Skill。桌面测试覆盖项目导航、对话、Coding 与场景工作区及设置。模型测试使用本地对端。运行 `npm run build:scene` 后可执行 STEP 导入回归。

Electron 测试需要可用的图形显示环境；Git、npm 等子进程测试需要运行环境允许启动对应程序。不可运行时应报告具体限制，不把跳过或未执行视为通过。

推送 `master`、提交面向 `master` 的 PR 或手动运行 Desktop CI 时，GitHub Actions 构建 Linux 和 Windows 安装包。Linux 任务复用打包时构建的 STEP worker，运行 lint 和不依赖图形环境的回归测试。推送版本标签时，Actions 还会生成签名并公证的 macOS 安装包，三个打包版都通过启动检查后才会发布。
