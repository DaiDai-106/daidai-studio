# GitHub Release

推送 `vX.Y.Z` 标签会构建 Linux x64、Windows x64 和 macOS Apple Silicon 安装包。打包前校验标签与 `package.json` 的版本一致，且 `CHANGELOG.md` 有标题为 `## [X.Y.Z]` 的变更记录。三个安装包都通过启动验证后，GitHub Actions 创建 Release，并从该记录提取发布说明。

## 配置 macOS 签名和公证

使用 Apple Developer Program 团队的 **Developer ID Application** 证书。在 Mac 的钥匙串访问中，将证书和对应私钥一起导出为带密码的 `.p12`。在 Apple 账户的「登录和安全」中生成 App 专用密码，并从 Apple Developer 账户的 Membership 页面查看 Team ID。[Apple 证书指南](https://developer.apple.com/help/account/certificates/create-developer-id-certificates) · [Apple App 专用密码](https://support.apple.com/en-us/102654)

在 GitHub 仓库的 **Settings → Secrets and variables → Actions → New repository secret** 中添加以下五项。[仓库 Secrets 设置](https://github.com/DaiDai-106/daidai-studio/settings/secrets/actions)

| Secret | 值 |
| --- | --- |
| `CSC_LINK` | `.p12` 文件的单行 Base64 内容 |
| `CSC_KEY_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_ID` | 有团队访问权限的 Apple 账户登录邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 为公证生成的 Apple App 专用密码 |
| `APPLE_TEAM_ID` | 证书所属的 Apple Developer Team ID |

在 Mac 上可以用以下命令将 `.p12` 的 Base64 内容直接复制到剪贴板，再粘贴到 `CSC_LINK`。

```bash
base64 -i "Developer ID Application.p12" | tr -d '\n' | pbcopy
```

GitHub Actions 只在推送版本标签时生成 macOS 安装包。签名和公证由 `desktop-ci.yml` 中的 macOS 发版任务执行。它会签名 `.app` 和 `.dmg`，提交最终 `.dmg` 给 Apple 公证，写入并验证公证票据，再挂载镜像验证应用启动。 [Apple 的 Mac 软件分发指南](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)

## 安装 Linux 包

下载 `.deb` 后可用 `sudo apt install ./dai-studio_0.0.1_amd64.deb` 安装，文件名按实际版本替换。安装包需要发行版提供 `libssl3t64`，例如 Ubuntu 24.04。
