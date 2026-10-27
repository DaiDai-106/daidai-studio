# CAD MCP 设计

更新：2026-10-26。状态：标准 stdio 插件重构已完成；12 个工具、C++ 类型分层、资源登记及显示产物元数据均已实现。桌面已按显示契约接管文件并驱动前端只读查看，不新增插件协议层。第一阶段保留全部 CAD 工具及几何能力，重组类型、协议与内部实现；内置 Skill 只覆盖 STEP 导入与显示。第 9 节离线对齐参照已实现。范围见 [规范入口](../README.md)，显示接管见 [桌面后端设计](../backend_spec/backend.md)。

## 1. 插件边界

resources/mcp/cad 是完整插件：官方 TypeScript MCP SDK 提供 tools/list、tools/call，TS adapter 调用独立 C++ 程序执行 OCCT 几何操作。每个插件拥有自己的标准 stdio MCP 服务进程。桌面与独立客户端统一复用 pi-mcp 连接同一入口；“内置”仅表示随应用分发和自动登记，不是一种传输方式。C++ 内部管道只传计算请求，不冒充另一套 MCP。

插件不依赖 SceneHost、桌面数据库、共享可编辑场景、应用对象 ID 或 Harness。桌面将真实发现的工具注册给 Harness；模型显式传 path、document、job 和 objectId，CAD 服务自行管理文档/任务/几何身份。

重构保持 12 个工具名称和几何行为。公开导入参数统一为绝对 path，内置与独立 stdio 使用同一契约；原先依赖桌面代填 document、对象 ID 转换或 selected-source 空参数的绑定退出。协议调整需同步更新契约、独立客户端测试和所有调用方，不保留两套长期入口。

## 2. 目录与分层

```text
resources/mcp/cad/
  contract.ts              # 所有工具 Schema、推导类型、错误及显示产物契约
  server.ts                # 标准 stdio 入口与配置读取
  service.ts               # 官方 SDK 注册、输入输出转换与进度
  types.ts                 # 启动配置与内部运行类型
  worker.ts                # 原生进程、请求关联、帧校验、取消和清理
  builtin.ts               # 插件随附的启动描述，不连接桌面或 Harness
  resources.ts             # 已生成资源的登记及受控读取
  CMakeLists.txt
  include/cad/             # 公共值类型与领域函数声明
  src/                     # 对应实现、main 及 private 内部头文件

tests/cad/
  *.test.ts                # MCP 契约、Harness 调用与几何结果验证
  native/                  # C++ 几何测试、STEP 样本生成器与 CMake 配置
```

本项目的 UNLICENSED 标识与原生依赖声明集中保存在仓库根目录 `LICENSE`，按归属分节，CMake 将该单文件安装到原生运行目录；源码与运行目录都不再维护 licenses 子目录。

测试统一位于仓库根目录 `tests/`。CAD 的 CMake 在 `BUILD_TESTING` 开启时加入 `tests/cad/native/`；测试目标名、输出程序和 CTest 入口保持一致。插件生产实现仍只位于 `resources/mcp/cad/`。

| C++ 层 | 职责 |
| --- | --- |
| types.h | 向量、变换、颜色、句柄、来源、对象、错误与限制等公共值类型 |
| document.h / document.cpp | CadDocument 的 RAII 所有权，内部 OCCT 细节留在 private |
| step_reader.h / step_reader.cpp | 读取经过校验的 STEP 快照，提取对象、实例、单位和颜色 |
| queries.h / queries.cpp | 类型化对象结构、属性及精确特征查询 |
| geometry.h / geometry.cpp | 集中定义和实现 B-Rep 有效性、几何量、最短距离及拓扑拆分，沿用原算法 |
| display.h / display.cpp 及网格模块 | 三角化、完整性检查、GLB、面映射及资源清单 |
| jobs.h / jobs.cpp | 任务种类、状态、进度和类型化成功结果；不依赖 MCP |
| service.h / service.cpp | 文档与单计算线程所有权、有界任务表、工具分发及取消；不混入网格算法 |
| serialization.h / serialization.cpp | JSON 与领域值类型的边界转换 |
| main.cpp | 配置、stdin/stdout 帧读取及退出 |

新增 jobs/serialization 的目标是拆开现有 service 的任务状态模型及 JSON 转换职责；实际拆分保持文件职责完整，不按每个函数建文件。相近的小型几何计算集中在 geometry.h / geometry.cpp，网格与读取模块继续独立；不按每个工具建文件，不重写已有有效算法。

## 3. 核心数据结构

| 类型 | 内容与生命周期 |
| --- | --- |
| CadHandle | serverInstanceId、id；用于 document/job，服务重启后失效 |
| SourceVersion | 规范绝对 path、sourceHash、importFingerprint、源长度单位；CAD 服务从实际读取的字节产生 |
| Transform | translation、rotation:[x,y,z,w]、scale；声明所属局部空间，长度米 |
| CadObject | objectId、sourceKey、parentObjectId?、name、kind、geometryId?、localTransform、childCount |
| CadDocument | 临时文档句柄、SourceVersion、对象/根索引和私有几何；精确 B-Rep 留在进程内 |
| CadJob | 句柄、kind、status、phase/progress、成功结果或错误；只属于当前服务 |
| GeometryFeature | featureId、objectId、topologyRef、type、origin、direction?、radius?；对象局部坐标 |
| ResourceRef | uri、mediaType、byteLength、sha256；URI 由服务登记，读取受服务作用域约束 |
| DisplayArtifact | schemaVersion:1、kind:cad-display、SourceVersion、manifest:ResourceRef；明确可交付的显示结果 |

C++ 函数优先收发普通结构体、枚举和结果联合。TS 在 contract.ts 用同一 Schema 推导类型并导出 tools/list 定义；C++ 显式序列化，不增加代码生成或第二套 JSON Schema 库。

坐标和四元数用同类型 number 数组表达，通过 minItems/maxItems 固定为 3/4 项。工具 Schema 不使用数组形式的 items 元组写法，避免模型服务拒绝整个工具列表；保留输入长度和数值类型校验。

全部 12 个输入 Schema 使用内联 object、显式类型的字符串 enum、基本数值类型及同类型数组，不引入引用、组合类型或 uniqueItems。对象 ID 不重复的业务约束由现有 C++ 查询校验；属性字段和特征类别由原生集合处理重复项。MCP 服务继续校验实际输入，文档/任务句柄、数组长度、字段类型和范围不因模型适配而放宽。

桌面将发现的 inputSchema 直接注册到 Harness，继续使用 pi-ai 的服务适配和工具参数校验；不另建 Schema adapter，也不统一强开 strict。可选参数在严格模式中的 nullable 转换及模型返回 null 的归一化交给 pi-ai，CAD 契约仍使用可选字段。后续增加模型偏好时复用 pi-ai 的 constrainedSampling，不手工给请求补 required/null，也不在请求失败后擅自删约束重试。

兼容性验收包括所有输入 Schema 的通用写法检查、pi-ai 严格模式转换、可选 null 回参归一化，以及 DeepSeek/OpenAI/Anthropic/Google 四类服务的真实请求构造路径（默认及 prefer strict）。自动测试在发送前截获请求，使用虚拟凭据并阻止网络访问；这证明本地注册和序列化链路可用，不等于所有远端模型或微调模型已实测通过。

2026-10-25 经用户明确授权，使用现有 DeepSeek API 凭据（deepseek-flash）及 OpenAI 订阅 OAuth（gpt-6-luna）完成真实工具调用验收。两者都通过现有桌面 Runtime/Harness、pi-mcp、标准 stdio 和 C++/OCCT 成功执行全部 12 个工具，无新增 adapter。临时 STEP 的 compound 实际拆为 2 个子对象，最短距离为 0.28 m，返回非空精确特征并生成 complete 显示资源。DeepSeek 无失败调用；OpenAI 一次 cad_wait_job 漏传 job.id，在 Harness 执行前校验失败后由模型补齐并成功调用，不能记作首次全无错误。取消接口对已完成任务准确返回 cancelRequested=false，本次实测不覆盖在途计算中断。测试项目和历史隔离后清理；现有 OpenAI OAuth 沿用原能力刷新并加密保存。验收结果仅对应上述两个实际模型，不扩展为全部模型保证。

桌面派生对象目录与 sourceKey/特征行段参照索引，见 [后端场景目录](../backend_spec/backend.md#13-已有场景目录与临时几何查询)。该索引不增加 MCP 工具或协议 adapter，不改变独立服务的 12 个工具输入。

sourceKey 表示该源文件/导入方式中的对象路径或实例身份；保存产物中的 objectId 在该产物中持续有效；重新导入的 objectId、geometryId 和 featureId 的有效范围以新 CAD 文档为准，通过同一 sourceHash/importFingerprint 下的 sourceKey 显式对应，不能混用，不冒充永久应用身份。实例分别拥有 objectId，可共享 geometryId。一个对象可含多个 Solid/Shell；保留文件对象组织，查询树可以有多个根。

启动时实际连接 stdio 并发现工具，不启动几何进程。桌面执行阶段按授权项目建立连接，轮次结束或退出等待连接关闭；独立客户端自己管理连接生命周期。

ServerConfig 单独定义 worker 可执行路径、允许的项目根（未绑定时不允许导入文件）、临时输出根和资源限制，由可信启动方提供。不是 LLM 工具参数，不含数据库、回调或场景对象。TS/C++ 注释必须说明所有权、单位、坐标空间和句柄失效规则。

## 4. 全部工具的输入输出

以下为重构后的公开契约概要；contract.ts 是唯一公开 Schema 来源，协议版本为 2。sourceId/projectId 不属于 CAD 的必填业务输入；应用来源由桌面的 RunContext 关联。请求 ID 仅关联管道消息；工具不要求 operationKey、sourceId 或 projectId。服务自行读取 path、计算快照哈希和导入指纹，不由桌面专用分支暗中代选文件。显式重复调用是新的请求；未知接受结果不自动重放。

| 工具 | 输入 | 成功 data |
| --- | --- | --- |
| cad_get_capabilities | 无字段 | 协议/解析器版本、serverInstanceId、格式、几何能力、质量档位与限制 |
| cad_import_step | path:绝对 STEP 路径、options?:源单位覆盖 | job:CadHandle |
| cad_get_structure | document、mode:children/all、parentObjectId?、nameContains?、cursor?、limit? | items:CadObject[]、nextCursor? |
| cad_get_properties | document、objectIds、fields:bounds/topology/appearance/validity/measures | items:属性结果[]；仅计算请求字段 |
| cad_list_geometry_features | document、objectId、topologyRef?、types、cursor?、limit? | items:GeometryFeature[]、nextCursor?、analysisComplete、warnings |
| cad_decompose_object | document、objectId | changed、parentObjectId、childObjectIds、childCount、objectCount |
| cad_measure_distance | document、first/second:{objectId,placement}、limit? | 米制最短距离、最近点对、算法参数及完整性；坐标在调用指定公共空间 |
| cad_build_display | document、quality:preview/standard/fine、features?:none/alignment | job:CadHandle |
| cad_get_job | job | CadJobState；成功的 display 任务附显示产物元数据 |
| cad_wait_job | job | 等待同一任务真实终态，返回同一 CadJobState 和进度通知 |
| cad_cancel_job | job | cancelRequested 及当前状态；调用者仍须确认终态 |
| cad_release_document | document | released:true；活动几何计算时返回 BUSY |

导入成功结果包含 document、SourceVersion、outputLengthUnit:m、objectCount、rootObjectCount、warnings。根和对象通过分页结构查询获得，导入成功本身不表示已有网格。

属性分别声明 exact/computed/unavailable 和原因；面积/体积/中心等数值积分结果报告误差，不伪装为解析精确值。特征类型保留 plane_center、circle_center、cylinder_axis、edge_midpoint、vertex。方向和局部原点不自动成为机械关节定义。

拓扑拆分保留原位置和原几何，只拆真实独立 Solid/游离 Shell 或解包已有子对象；不抽出 Solid 内部壳、不切割融合实体、不做布尔融合。拆分后需由模型另行选择生成显示，桌面不自动补调 CAD API。

距离计算使用原始 B-Rep 及显式 placement，不从前端临时姿态或隐藏的应用场景取位姿。零距离不等于碰撞检测结论。

## 5. 响应、异步任务与错误

参数不符合 Schema 或工具名称未知时使用 MCP 的 InvalidParams 错误；几何与文件操作错误使用下述结构化结果。

MCP 返回 content 的有界摘要和 structuredContent 的完整有界结构：成功 `{ok:true,data:T}`，失败 `{ok:false,error:CadError}` 且 isError:true。CadError 为 code、message、objectId?、topologyRef?，不返回原始异常或敏感日志。

CadJobState 为按 status/kind 区分的联合：queued/running/cancelling 携带进度；succeeded 携带 import/display 对应结果；failed 携带错误；cancelled 不伪造成功结果。cad_get_job 查询成功而计算 failed 时，外层仍可 ok:true，失败位于任务状态。

保留一个活动文档、一个几何计算槽，CAD jobs 只负责原生计算，Harness 管对话工具执行。等待 API 由服务可靠等待真实终态，不自行选择下一项业务。队列和保留结果都有界，重复查询不重新计算或重复生成资源。释放文档保留已完成任务及资源；达到 maxRetainedJobs 时明确要求重连，不另建自动淘汰账本。

未知句柄/旧服务实例、错误参数、越界路径、文件变化、缺失单位、外部 STEP 引用、资源超限分别报告明确错误；网格检查失败的面不参与显示，保留原 CAD 与诊断，其他面继续生成显示资源。源外部引用在读依赖前拒绝；未知单位须显式 override；不猜测来源信息。

请求取消与已接受 job 取消分开：仅取消等待不代表几何停止。停止、连接断开或接受响应未知时，服务须等待协作取消/真实退出；必要时释放整个 worker，旧句柄失效。stdout 仅用于协议帧，日志走 stderr。重复 close 共用清理过程，正常 EOF 必须退出并清理私有暂存。原生响应不符合契约时，必须拒绝包括该响应在内的所有未完成请求并等待进程退出，不遗留挂起 Promise。

## 6. 显示资源与通知契约

显示成功结果保留 manifest 资源引用与 summary。首次或重复查询有可显示三角形的成功 display job 时，服务均在 CallToolResult 的 `_meta["dai/display"]` 返回同一 DisplayArtifact，包含 `complete=false` 的部分显示；queued/running/failed/cancelled 及普通几何查询不提供可发布描述。所有面均不可显示时任务失败，保留上次显示。

`dai/display` 是应用约定的元数据键，MCP 本身不定义三维产物语义。模型仍获得真实显示结果；桌面通用适配据该字段接管资源，再将持久引用写入 Harness details，见 [后端工作流](../backend_spec/backend.md)。插件不调用前端、不保存应用导入索引。

| 清单内容 | 要求 |
| --- | --- |
| schemaVersion、SourceVersion、quality、complete、omittedFaceCount、warnings | complete 表示网格整体是否通过检查；排除面按唯一几何计数，重复实例不重复累计 |
| objects、roots | 保留全部对象层级、位置、名称和 CAD 几何身份；shape 的 display 给出 faceCount/omittedFaceCount，无可显示面的对象不提供 geometryResourceUri，仍保留在树中 |
| 原始颜色与实例外观 | 保留对象/面颜色；缺失时明确默认材质 |
| 对象到 GLB 节点/网格的映射 | 每个可选对象能回到对应 CAD 身份；同几何多实例分别映射 |
| resources | GLB、面映射等 ResourceRef；面映射包含 omittedFaces（geometryId/topologyRef），排除面不得出现在任何三角形范围中；清单和资源大小受预算限制 |
| 坐标约定、displayToScene 变换 | 对象坐标使用米、右手 Z-up；GLB 遵循 glTF 约定，资源根只做一次明确的显示坐标转换 |

显示包围盒由 GLB 派生；当前精确对象包围盒通过 cad_get_properties 按需查询，清单不重复保存一份几何属性。已增加有明确用途的离线对齐特征，见第 9 节。

三角面到 CAD 面的映射继续保留，为后续精确选取准备，不在第一阶段增加几何特征编辑 UI。大网格不塞入模型文本、SQLite 或工具 details。

资源 URI 由该服务实例登记到自己的只读输出；小型清单可使用标准 resources/read。同机 stdio 服务的资源 URI 由登记表解析为只读本地文件 URI；可信宿主可验证清单、大小、哈希后流式复制。标准 resources/read 仅支持有界小资源，resources/list 每页最多 50 项；resources/read 上限 1 MiB，大文件明确拒绝一次性读取，不额外开放 HTTP 端口。桌面已接入同机资源接管与前端加载；远程大资源传输单独设计。

资源读取器只负责已登记资源及清理，不接收 SceneHost 或桌面保存函数。服务存活期间，有界保留已登记产物；cad_release_document 只释放几何文档，不删除已登记资源。取消/失败的任务清理未登记输出，服务关闭清理全部私有输出。服务 close 最终清理私有输出，已被桌面接管的文件归桌面所有。

## 7. 几何、构建与质量约束

- 复用 OCCT/XCAF，保留真实对象层级、实例、颜色与源单位；无装配或有效开放 Shell 不因缺少 Solid 被拒绝。
- 文件在验证和解析间保持一致，复用服务私有只读字节快照。hash 以实际读取字节为准；不改写用户 STEP。
- 保留网格失败诊断及已有经验证的局部恢复规则。检查不通过的面只从显示资源排除，CAD 曲面、拓扑与诊断不删除；complete 保持 false，不通过强行修复或清除状态伪造完整成功。无法归属到具体面的整体网格失败保守地不显示该几何，其他几何继续。
- CMake 只 find_package 已安装的 OCCT、JSON、OpenSSL、TinyGLTF、Threads 等依赖；无 FetchContent、源码补丁或在线安装。原生程序、依赖库和许可随目标平台包分发。
- C++ 公开头文件和源文件对应，private 放 OCCT/网格内部细节；避免以 Json 字段访问代替领域结构，避免把所有代码挤进 types.h 或 service.cpp。
- 保持现有几何误差、预算、超时和诊断的真实含义；质量档位只影响网格，不保证修复 B-Rep。

## 8. CAD 验收

1. 全部 12 个工具经标准 SDK 与 pi-mcp 可发现、可调用；桌面/独立 stdio 使用同一工具契约，测试不依赖桌面场景服务。
2. 真 STEP 的装配/平铺、重复实例、Solid/Shell、名称、位置、颜色和单位符合源文件；原文件保持不变。
3. 输入/输出 Schema、错误句柄、分页上限、任务状态、取消、EOF、释放和重连失效均覆盖真实协议边界。
4. GLB、对象映射、CAD 面映射、hash/大小与显示坐标经过验证；显示任务完成后能交付独立于活动 CAD 文档的资源。
5. 复测属性、精确特征、拆分和最短距离，重构不删减已有 CAD 能力；内置 Skill 只验收导入/显示路径。
6. 真实 STEP 部分显示需通过实际 Harness、资源保存与 Electron 回显：问题面不绘制，恢复的面继续显示，诊断和 complete=false 保留；全部不可显示或资源校验失败保留旧画面。

部分显示校验：manifest.omittedFaceCount、每个几何的显示面计数和 faces.json.omittedFaces 必须一致，已显示与排除的面互不重叠，覆盖原面计数；重复实例按 geometryId 共享计数。继续校验来源、路径、大小/hash、对象树及完整三角形映射。兼容此前未带面计数的 complete=true 产物；旧 complete=false 且没有排除记录的产物须重新生成，不当作已过滤网格。

## 9. 可离线读取的对齐参照（已实现）

清单、GLB 和面映射包含已发布显示结构；启用 features=alignment 时另存平面、圆和圆柱参照，**不包含完整 B-Rep 或所有类别的精确特征**。不能承诺释放 CAD 后仅凭三角网格还原精确圆心、圆柱轴或任意曲面。本阶段保存既有查询能提取的对齐参照，不设计另一种 CAD 内核或通用场景数据库。

保留 12 个工具。在 `cad_build_display` 增加可选 `features: none/alignment`，缺省 none 兼容现有调用；scene-building Skill 显式选择 alignment。C++ 在同一 display job、文档仍有效时复用 queries 中的特征提取，导出平面、圆心和圆柱轴；不让桌面逐对象补调 CAD 工具。不支持的曲面明确没有对应参照，不用网格拟合冒充 CAD 结果。既有 vertex/edge_midpoint 及其他工具仍保留在线查询能力，首批离线缓存不承诺覆盖所有几何操作。

含特征的清单使用 schemaVersion 2，无缓存的清单仍为 1；DisplayArtifact 外层交付信封保持 schemaVersion 1，含义与清单版本独立。增加资源角色和特征索引，不改变旧角色含义：

| 资源/字段 | 数据与约束 |
| --- | --- |
| manifest.json | 格式化 JSON；完整对象树、实例局部变换、原始外观、坐标约定及资源目录；提供每对象特征记录的行范围和分析状态 |
| GLB / face-map | 保持原网格、CAD 面映射和排除记录；继续用于前端显示与拾取，不塞入 LLM 文本 |
| geometry-features 资源 | JSONL，一条特征一行，具有独立 schemaVersion、sourceHash、importFingerprint；清单登记其角色、URI、大小及 hash |
| 特征记录 | featureId、objectId、geometryId（如有）、topologyRef、type、origin、direction?、radius?；复用 GeometryFeature，不新建永久全局特征 ID |
| 分析状态 | 按对象标记 analysisComplete、数量与 warnings；已计算但无相应特征，与未分析/失败/截断必须区分 |

origin/radius 以米为单位，origin/direction 处于对应对象局部坐标。调用方沿对象祖先变换得到原模型坐标，再应用当前 Placement 得到世界坐标；不能把实例位置应用两次。对重复几何保留实例身份，避免只用 geometryId 定位具体零件。特征来自 B-Rep 解析或既有数值计算，保留容差和诊断；平面中心不冒充机械安装原点，轴方向符号不代表设备语义。

缓存身份限定于同一 sourceHash、importFingerprint 和该显示包的对象/拓扑版本；源文件内容相同也不能跨拆分版本盲目复用 ID。插件导出时不知道桌面的 importId，桌面接管后关联，后续 Alignment 以 importId 授权完整资源包。相同 STEP 新导入不得把旧特征混入新模型。

特征导出沿用任务取消、预算和进度；上限为 100,000 条、32 MiB、每行 16 KiB；行索引支持 read 的 offset/limit。达到限制或提取失败时保留可用显示并标记分析不完整；显示 complete 与特征 analysisComplete 独立，不能相互替代。需要的参照缺失时 Alignment 明确拒绝该精确操作，仍可使用明确标注的显示包围盒。

资源登记、summary 和 `_meta["dai/display"]` 继续同一交付路径。桌面接管从硬编码“两份资源”改为按已知角色及版本校验，允许新增特征文件，保持依赖、路径、hash/大小和总预算检查；不为此增加另一套传输层。v1 产物继续显示且支持网格包围盒定位；精确特征能力显示为不可用，不静默重新解析。只有用户显式重新导入时生成新版包。

验收包含对象局部/世界坐标转换、重复实例、旋转放置、无解析特征、部分网格但有效 B-Rep 特征、特征截断/失败、hash 不匹配及释放后读取。CAD 文档和 worker 关闭后，新包仍能独立支持已定义的离线对齐能力；不承诺支持依赖完整 B-Rep 的未来布尔或拓扑修改。

已有显示与临时文档分开：cad_import_step 只打开原始 CAD 并返回任务；cad_get_structure / cad_get_properties 等查询不生成显示产物。普通保存场景问题优先读取宿主登记的 manifest；未缓存的精确 B-Rep 查询可使用临时文档，不自动追加 cad_build_display。保持现有 12 个工具和 Schema；发布新显示仍由 cad_build_display 的真实结果触发。

显示质量策略：初次生成、普通查看及整机定位默认 preview，standard/fine 仅用于用户明确提出的更精细显示。“完成场景搭建/精确对齐”不等于提高网格质量；不因 complete=false、排除面或等待时间自动升级。当前基础参数为 preview：线性偏差 0.001 m、角偏差 0.5 rad；standard：0.0003 m、0.3 rad；fine：0.0001 m、0.15 rad。它们是网格化参数，不是原始 CAD 的精度，也不是最终所有网格点的误差保证；局部恢复仍使用已有自适应策略。精确特征、B-Rep 查询与显示质量分开。
