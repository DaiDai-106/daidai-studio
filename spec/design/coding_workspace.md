# Coding 工作区设计

本文记录当前实现，以代码和运行时契约为准。Coding 工作区按项目提供文件浏览、Git 差异、网页预览和聊天文件引用；文件与 diff 视图只读，不提供编辑、Git 写操作、终端或自动启动服务。整体布局见 [前端与交互](frontend.md)。

## 架构与数据流

```text
聊天文件引用 ──→ 会话发送 ──→ 后端读取项目文件，追加内容快照 ──→ Pi 会话
       │
       └─ 文件链接 ──→ Coding 工作区标签

工作区（React） ──→ preload / 应用 IPC ──→ Node 后端
  ├─ 文件树、搜索、文本读取 ──→ coding/file_service ──→ 项目目录
  └─ 变更、diff ──→ coding/git_service ──→ Git 与项目目录

网页标签 ──→ preload / 预览 IPC ──→ Electron 主进程 WebContentsView
                                 └─ 静态 HTML：本地受控服务 ──→ 项目目录
```

后端从项目 ID 查找工作目录，文件操作仅接受 Coding 项目的相对路径；文件浏览与 Agent 工具权限无关。静态预览由主进程通过后端确认项目身份，并复用 Node 目录句柄读取逻辑。网页是独立的原生视图，不通过主应用 IPC 向页面暴露接口，也不会自动把网页内容交给模型。

| 代码 | 职责 |
| --- | --- |
| `src/renderer/features/coding/logic/use_coding_workspace.ts` | 管理项目布局、导航和标签，协调恢复和保存 |
| `content_tabs.ts`、`workspace_storage.ts` | 标签状态转换；本地状态的校验、持久化与恢复 |
| `components/coding_workspace.tsx` | 组合导航、标签和内容面板 |
| `components/file_tree.tsx`、`file_search.tsx`、`changes_list.tsx` | 按需读取文件树、搜索和变更列表 |
| `components/text_content_panel.tsx`、`code_view.tsx`、`diff_view.tsx` | 文本/diff 读取、刷新和展示 |
| `components/web_preview.tsx` | 预览操作、状态事件及原生视图可见区域同步 |
| `src/backend/coding/` | 受控文件访问、搜索、文件引用快照和 Git 查询 |
| `src/desktop/main/browser/` | 原生预览、来源限制及静态资源服务 |
| `src/shared/file_references.ts`、`src/shared/node/file_access.ts` | 路径引用解析、Node 受控目录和文件读取 |

表中未带 `src/` 的路径均相对于 `src/renderer/features/coding/`。跨进程契约定义在 `src/contracts/application.ts`、`bridge.ts` 和 `web_preview.ts`；后端命令调度见 [后端与数据](backend.md)。

## 状态与数据结构

`use_coding_workspace.ts` 为当前项目持有一份 `WorkspaceState`；工作区不依赖活动聊天，同一项目切换会话保留标签和布局。切换项目时按新项目恢复状态，旧项目异步结果不能写入新界面。

| 状态 | 内容与默认值 |
| --- | --- |
| `open` | 整体工作区是否展开；首次默认 `false`，后续恢复已保存状态 |
| `width` | 工作区宽度百分比；默认 `50`，恢复时接受 20–80 |
| `navigation` | `files`、`changes` 或 `null`（收起导航）；默认 `files` |
| `tabs` | `{ items, activeId }`；默认空列表及 `null` |

每个标签有 UUID `id` 与 `content`：文件为 `{ type: "file", path, startLine?, endLine? }`；差异为 `{ type: "diff", path, kind }`，`kind` 为 `staged`、`unstaged` 或 `untracked`；网页为 `{ type: "preview", url, file? }`。文件以路径复用，重新打开可更新行范围；diff 以路径和基准复用；网页每次打开都是独立实例。关闭活动标签时选择原位置上的下一标签；没有下一标签时选择前一标签，全部关闭则无活动标签。

状态保存在 renderer 的 `localStorage`，键为 `dai:coding:<项目 ID>`，记录版本 `1`。只恢复文件和差异标签，不保存网页地址、Cookie 或页面状态；恢复文件标签时只保留路径，不恢复定位行。最多保存 100 个文件/diff 标签，超限优先保留活动项，再保留最近打开的标签并显示提示；无有效活动项时选择最后一个有效标签。读取时校验版本、宽度、路径、标签 ID 和差异类型，跳过无效标签；解析或存储失败显示提示，使用默认布局或继续当前会话。

文件树展开项、目录分页结果、搜索结果、文本内容及网页运行状态属于临时状态；恢复标签后重新读取磁盘，不保存文件内容。布局状态是本机恢复信息，不是项目备份。

## 请求与响应

实际字段校验和长度限制以 `src/contracts/application.ts` 为准；以下为主要语义。所有请求均带 `projectId`。

| 请求 | 输入 | 结果 |
| --- | --- | --- |
| `coding.list` | 目录 `path`、`offset`，续页附 `snapshot` | `entries: { name, directory }[]`、`snapshot`、`nextOffset`；每页最多 200 项 |
| `coding.read` | 文件 `path` | UTF-8 `content` 与文件字节的 SHA-256 `version` |
| `coding.search` | `query` | 匹配的相对 `paths` 和 `truncated` |
| `coding.changes` | 无额外参数 | `{ path, staged, unstaged, untracked }[]` 和 `truncated` |
| `coding.diff` | `path`、`kind` | `patch` 和 `untracked` 标记 |

目录先列目录再列文件，各自按名称排序；分页快照是目录可见项的哈希，续页期间目录变化会报错，需刷新后重新读取。目录只显示普通文件和目录，不跟随符号链接。搜索忽略 `.git`、`node_modules`、虚拟环境及常见构建目录；最多扫描 10,000 项、返回 100 个文件，深度小于 32 层，检查点时间预算为一秒。空关键词返回首批文件供 `@` 选择；扫描中已消失、不可读或换成链接的子目录跳过，根目录失败仍报错。文件/目录缺失以项目相对路径提示刷新，不暴露内部句柄路径。系统单次目录枚举不受硬超时保证；达到上限时 `truncated` 为真。

网页走独立的预览桥：按 `projectId` 和 `tabId` 打开 URL 或项目 HTML、更新视图边界、执行后退/前进/刷新/关闭，并接收加载状态、来源、导航能力及错误。具体类型见 `src/contracts/web_preview.ts`。

## 交互与生命周期

- Coding 宽窗口中间为聊天、右侧为工作区，首次默认收起；展开时默认各占可用宽度的一半；分隔条可拖动或用方向键调整。窄窗口通过聊天/代码页签切换。整体收起时在聊天标题栏保留展开入口，聊天恢复居中限宽，消息与输入区使用一致宽度；文件/变更导航可独立收起，内容标签不关闭。
- 展开目录时按需加载，支持加载更多、刷新和失败重试；文件搜索选中后打开文件。HTML 文件有单独的预览入口。导航切换不关闭内容标签；文件树切到变更时保留。
- 激活文件或 diff 标签、窗口重新获得焦点或点击刷新时重新读取；只接受当前有效请求的结果，刷新时保留已显示内容，失败显示原因。文件树和变更列表按需刷新，不使用常驻文件监听。
- 文件工具栏以省略显示的路径和右侧操作组排列；源码/预览使用分段切换，刷新复用共享图标按钮。Markdown 文件可切换源码与渲染预览，复用聊天的 Markdown 渲染；文件链接相对于文档目录解析，支持 `#L` 行号，指定行号时切回源码定位，拒绝越出项目。聊天和行内代码仍使用项目相对路径。超过高亮大小/行数限制的 Markdown 回退源码；不解析普通标题锚点，也不直接获取图片。文件读取支持不超过 2 MiB 的 UTF-8 文本；二进制或不支持的编码报错。Shiki 按扩展名与主题高亮；超过 200,000 字符、5,000 行或单行 10,000 字符时显示完整纯文本，失败或未知语言也可回退原文。
- 变更区区分已暂存、未暂存和未跟踪文件：分别比较 HEAD/索引、索引/工作目录、空内容/新文件。无首次提交时已暂存项与空树比较。最多列出 200 个变更，Git 命令输出上限 2 MiB；未跟踪文件 diff 限 200,000 字符和 5,000 行。超限、超时或读取失败明确提示，不执行暂存、提交或回滚。
- 在 diff 中点击选择一行，Shift 点击选择范围，填写批注后添加到当前会话草稿；用户检查后自行发送。草稿包含路径、比较基准及选择时的差异快照，不随文件刷新改变。单次选择最多 200 行、32,000 字符；大 diff 以纯文本展示且不支持批注。相同内容的刷新保留未添加的批注；差异变化后清空旧选择并提示重新选择。切换会话时未添加的批注不会转移。
- 网页标签由用户打开 HTTPS、本机 HTTP 或项目内 HTML，提供地址、后退、前进和刷新。切换标签、收起工作区或出现遮挡时隐藏原生视图而保留实例；关闭标签或切换项目释放视图，未完成初始化也会取消。最多 10 个预览，初始化中的实例计入上限；网页不跨重启恢复。

## 聊天文件引用

聊天输入 `@` 或点击引用入口，在输入框上方显示紧凑文件候选（文件名与目录）；继续输入过滤，↑/↓ 切换、Enter/Tab 选择、Escape 关闭，不移动输入焦点。选择后生成可移除、可打开的文件标签，不提供行范围表单。草稿以 `@"src/main.ts"` 保存；发送时读取完整文件，追加路径、行号、SHA-256 和内容快照。模型和历史使用同一快照，历史默认折叠；磁盘后续变化不改变已有快照。旧草稿中的显式行引用仍兼容。

每次最多 5 个不同引用，每个最多 32,000 字符，合计最多 64,000 字符（含行号）。读取沿用 2 MiB 上限；引用无效、越界、文件缺失或过大时拒绝发送并保留草稿。仅 Coding 会话展开此类引用；Markdown 围栏代码块内的内容作为数据，不解析其中的 `@` 引用。

聊天中的 Markdown 文件链接或行内代码（如 `src/main.ts:12`、`src/main.ts#L12-L20`）可打开准确的项目相对路径并定位；不猜测同名文件，也不授权绝对路径。文件不存在或行号超出当前内容时显示提示。

## 安全与平台边界

Linux、Windows 和 macOS 均提供只读文件树、源码、文件搜索和 Git 变更。Linux 通过已固定的目录句柄读取。Windows 和 macOS 校验规范路径和文件身份来拒绝符号链接、目录联接和读取期间可检测到的目录替换，适用于用户选定的本地项目。项目静态 HTML 预览通过目录句柄提供 HTTP 资源，目前仅在 Linux 开放。Agent 文件工具、已授权 shell 和第三方扩展各有权限边界。

Git 变更依赖系统 PATH 上的 Git。服务使用参数数组运行 Git，禁用外部 diff、textconv、文件系统监控命令和远程协议。检测到过滤器配置时检查项目文件属性，有文件使用过滤器或无法安全检查时拒绝读取。项目位于更大仓库的子目录时只显示项目范围内的变更。项目目录位于 Git 实际工作树之外时提示原因。

预览地址不接受凭据：无协议域名默认 HTTPS，本机回环地址可用 HTTP。HTTPS 使用系统网络和默认 TLS 校验，允许 HTTPS 跨来源资源及 WSS，不承诺隔离所有内网 HTTPS；本机 HTTP 与静态 HTML 限制初始来源并支持同源 WS。导航不允许任意 `file:`、`javascript:` 等协议。静态 HTML 拒绝隐藏路径、越界及符号链接，单资源上限 8 MiB。

每个网页标签使用独立内存 session 和无 preload 的 `WebContentsView`，禁用 Node，启用上下文隔离和沙箱，拒绝新窗口、下载及敏感权限。复杂站点、登录、工业项目和其他平台需在实际环境验证。

## 验收

| 范围 | 回归入口与检查重点 |
| --- | --- |
| 状态与标签 | `tests/renderer/coding/content_tabs.test.ts`、`workspace_storage.test.ts`：资源复用、项目隔离、持久化与超限恢复 |
| 文件和引用 | `tests/backend/coding/file_service.test.ts`、`references.test.ts`、`tests/renderer/coding/file_references.test.ts`：路径约束、分页快照、搜索和引用内容 |
| Git 与展示 | `tests/backend/coding/git_service.test.ts`、`tests/renderer/coding/syntax_highlighting.test.ts`、`tests/integration/coding_workspace_ui.test.ts`：差异基准、过滤器、高亮和界面展示 |
| 聊天协作 | `tests/integration/coding_collaboration_ui.test.ts`：搜索、引用草稿、模型收到的快照和聊天文件定位 |
| 网页 | `tests/desktop/preview_urls.test.ts`、`static_preview.test.ts`、`tests/integration/web_preview_ui.test.ts`、`https_preview_ui.test.ts`：来源限制、静态资源、视图生命周期与 TLS 隔离 |

Electron 集成测试需要图形环境；HTTPS 测试使用本地对端，不等于公网或任意站点兼容性验证。执行入口、环境要求及历史结果见 [测试与验收](testing.md)；测试文件存在不代表当前工作树已通过。
