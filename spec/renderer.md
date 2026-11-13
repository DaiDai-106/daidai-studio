# 前端目录说明

`src/renderer/` 是 Electron 的渲染界面。以下相对路径均以该目录为基准。前端通过桌面桥接访问应用能力，前后端共用的数据契约位于 `src/contracts/`。

- `app/`：应用布局、应用级状态、桌面窗口与工作台协调。
- `shared/`：前端多处共用的界面组件、工具和样式。
- `features/`：聊天、项目、Coding、场景、机器人和设置等功能。项目主页与项目模式定义归 `projects/`；Coding 工作区状态由 `coding/logic/use_coding_workspace.ts` 统一拥有。
- `styles/`：主题变量、基础元素样式以及全局样式加载入口。

较大的功能目录内，`components/` 放 React 组件（TSX），`logic/` 放状态、类型与工具（TS），`styles/` 放 CSS。机器人等小功能直接平铺组件、数据与样式，避免只有一个文件的分类目录。`main.tsx`、`index.html` 和环境声明是构建入口，保留在根目录。

全局样式在 `styles/index.css` 中按既有顺序加载；仅由特定组件使用的样式由该组件引入。增加或调整样式时应检查浅色、深色和窄窗口，避免全局规则影响其他功能。

遵循仓库的 Biome 格式。中文注释说明职责、约束和不直观的原因，不逐行重复代码。涉及跨进程数据时使用 `src/contracts/` 的契约，避免在前端复制一套定义。

应用外壳负责组合与导航，功能组件负责各自界面；功能私有状态与存储逻辑留在功能目录。`shared/` 不反向依赖某个功能的类型定义，跨进程类型直接复用 `src/contracts/`；附带当前订阅消息的会话界面类型归 `features/chat/logic/types.ts`。共享欢迎形象位于 `shared/components/dai_mascot.tsx`，主页与形象样式跟随组件加载。

`app/components/app.tsx` 组合项目导航、设置与应用级弹窗；`project_workspace.tsx` 拥有各项目面板、分隔条、STEP 导入弹窗和聊天入口。面板切换及布局状态留在项目工作区，会话切换和草稿提交由 `use_workbench_navigation.ts` 协调，激活与清空统一经过同一个入口。

`app/logic/application_client.ts` 负责工作区快照、局部事件与会话写入的一致性，`use_application.ts` 通过 React 外部存储订阅状态。修改串行提交；刷新和分页受写入、请求版本及连接代次约束；删除记录阻止迟到快照复活会话。聊天进度只复用匹配分支的历史数组。

## 数据与验收

前端工作区快照、当前会话视图和错误由 `app/logic/application_client.ts` 统一维护；项目工作区、草稿及功能局部状态分别由对应组件或 hook 管理。数据流、切换规则与验收入口见 [前端与交互](design/frontend.md#数据流与状态)；Coding 的项目级本地状态及标签结构见 [Coding 工作区](design/coding_workspace.md#状态与数据结构)。跨进程字段以 [应用契约](contracts.md)和代码为准。
