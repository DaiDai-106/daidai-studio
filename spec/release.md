# Linux x64 发布

推送 `master` 时，`.gitlab-ci.yml` 运行单个 Linux x64 发布任务。任务串行计算版本、执行 `npm run check`，然后复用已通过测试的构建生成 `.deb` 并验证打包版启动。全部通过后，任务用 `CI_JOB_TOKEN` 将安装包上传到 Generic Package Registry，并创建 GitLab Release。下载权限遵循项目和包仓库的访问规则。私有项目可从 Package Registry 的网页下载对应文件，或用具备读取权限的 GitLab 凭据请求下载地址。

第一个稳定版本为 `v0.0.1`。之后按这条发布线的最高稳定标签增加补丁号。下一次发布前，在 `CHANGELOG.md` 中加入对应的二级标题，例如 `## [0.0.2]`，并写入该版改动。缺少条目时，发布任务会在打包前报错。CI 将同一个版本写入安装包和版本页，并从该条目提取 Release 正文。已发布的提交重试时复用原有 Release。流水线按 GitLab 的推送事件触发，一次推送多个提交时为该批次生成一个版本。

发布任务需要能执行无标签任务的 Linux x64 Docker Runner，使用 `node:22-bookworm` 和 Chromium 沙箱运行 Electron 测试。GitLab 项目需允许上传 Package Registry、创建 Release 和稳定版本标签。若 `master` 流水线同时入队，可将 `dai-studio-release` 资源组的处理顺序设为 `oldest_first`。脚本拒绝在比最新稳定标签更早的提交上创建新版本。

下载 `.deb` 后，可通过 `sudo apt install ./dai-studio_0.0.1_amd64.deb` 安装。安装包需要发行版提供 `libssl3t64`，例如 Ubuntu 24.04。
