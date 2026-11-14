# 公司插件目录接入

公司市场共用发现和安装流程，但资源按宿主区分：Pi Agent 加载 Extension、Skill、Prompt 和终端主题；Desktop 主进程加载 `dai.themes` 声明的桌面主题。共用包管理不代表共用插件运行时。

## 连接

「设置 → 插件与技能 → 公司内部 → 配置来源」支持：

- 无需目录登录的 HTTPS JSON 地址，不含凭据、查询参数或片段，不跟随重定向。
- `git:HTTPS/SSH` 仓库地址，默认分支根目录提供 `catalog.json`，使用系统 Git 凭据。SSH 可使用 `git` 用户，不支持内嵌密码。

内部目录地址：

```text
git:ssh://git@gitlab.roboticplus.com/dairobot/daidai_plugin/catalog.git
```

Git 目录只获取裸仓库并读取 JSON，不检出、不执行插件或 npm。请求超时 20 秒，响应最多 4 MB。私有仓库访问需要目标机器配置 Git 和 SSH；HTTP Git、本地路径及目录网页登录暂不支持。留空保存可断开连接。

## 格式

```json
{
  "schemaVersion": 1,
  "packages": [{
    "id": "dai-claude-theme",
    "host": "desktop",
    "name": "Dai Claude Theme",
    "description": "适配 daidai_pi 的浅色与深色桌面主题。",
    "publisher": "Dai 团队",
    "version": "0.1.2",
    "installSource": "git:ssh://git@gitlab.roboticplus.com/dairobot/daidai_plugin/dai-claude-theme.git",
    "resources": ["desktop-theme"],
    "homepage": "http://gitlab.roboticplus.com:2022/dairobot/daidai_plugin/dai-claude-theme"
  }]
}
```

`packages` 最多 1000 项，ID 不重复。`readme` 可额外提供 Markdown；`host` 可填 `pi` 或 `desktop`，省略时根据资源类型补齐，其余示例字段必填。资源可包含 `extension`、`skill`、`prompt`、`theme`、`desktop-theme`；声明不等于完成兼容验证。公司目录不能自行授予 Dai 已验证标记。

`installSource` 支持 Pi npm 规格和 HTTPS/SSH Git 来源，不接受本地路径、HTTP Git 或嵌入密码。Git 固定引用使用 Pi 的 `@ref` 语法；仅填写实际存在的引用。当前每个目录条目提供一个版本，更新时同时更新版本与安装规格。

市场来源和运行宿主独立：公司目录可同时发布 Pi 与 Desktop 插件。`host` 必须与资源声明一致，安装后还会校验实际清单，目录提示不能替代校验。`desktop-theme` 只允许全局安装，安装后在外观设置选择；`theme` 仍表示 Pi 终端主题。第一版不接受同时包含 Pi 和 Desktop 资源的混合包，请拆分发布。

两类插件共用发现与安装任务，配置和加载分开。Pi 使用 `agent/packages/`，Desktop 使用 `desktop/packages/`；Desktop 操作不依赖 Agent 会话。主题加载器通过 `package.list({ host: "desktop" })` 获取安装快照，不读取公司市场配置。目录服务只提供发现、条目关联和展示信息。

## 缓存与安装

HTTPS JSON 请求超时 12 秒，响应最多 4 MB；目录条目在进程内缓存 5 分钟。网络失败可展示本进程旧结果，安装前仍重新读取目录并校验版本。Git 目录共用同一缓存规则，裸仓库存放于 `catalog/git/`，不作为离线批准安装的依据。

目录地址与安装来源关联分别存储于 `catalog/sources.json`、`origins.json`；实际包安装配置按宿主分别位于 `agent/packages/` 与 `desktop/packages/`，来源关联也记录宿主。目录切换不会静默改写旧包来源。

目录查询和详情不执行插件。用户确认安装后，Pi SDK 负责包下载和配置，Git/npm 安装可能运行依赖脚本。Agent 扩展与 Desktop 声明式主题分别由各自宿主装配。

应用启动时若数据根下尚无 `catalog/`，会将旧 `agent/catalog/` 整体搬迁，保留目录配置、来源关联和 Git 索引；已有新目录时不覆盖，也不自动合并两套配置。
