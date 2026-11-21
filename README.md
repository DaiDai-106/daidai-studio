![Dai Studio](resources/icons/app.svg)

# Dai Studio

Dai Studio 是基于 Pi Coding Agent SDK 的本地 AI 编程桌面工作台。

- 按项目管理 AI 对话、消息队列和对话轨迹。
- 在工作区浏览项目文件、查看 Git 差异和预览项目内 HTML，目前支持 Linux。
- 安装 Pi 插件，管理用户技能和桌面主题。

## 安装

安装包按平台提供于  [GitHub Releases](https://github.com/DaiDai-106/daidai-studio/releases)

## 快速开始

从源码运行需要 Node.js ≥22.19、npm ≥10 和图形桌面环境。

```bash
npm ci
npm run dev
```

本地打包可运行 `npm run package:win` 或 `npm run package:deb`。macOS 安装包由 GitHub Actions 随版本标签发布。 [发布说明](spec/release.md)

[更新日志](CHANGELOG.md) · [详细文档](spec/README.md)
