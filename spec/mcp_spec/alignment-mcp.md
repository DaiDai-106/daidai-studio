# Alignment MCP

模型选择参照与参数，C++ 从已保存产物查询世界坐标并计算绝对旋转和平移；TS 封装协议，桌面在 Harness 成功后保存和通知前端。

桌面通过可信启动配置提供当前项目的用户目录场景数据根，Alignment 仅从该根读取授权产物，工具输入仍使用 `importId`；定位由桌面写入。见 [后端设计第 14 节](../backend_spec/backend.md#14-用户目录场景存储)。CAD 仍从原项目目录读取 STEP；旧项目内产物不自动迁移。

首轮平移功能已扩展为下文的完整定位契约；保留旧定位文件和旧 Harness 结果的读取兼容，不改写原始 STEP 或 GLB。

## 边界

- `resources/mcp/alignment/` 独立标准 stdio 服务，官方 TS SDK 封装；C++/TinyGLTF/Eigen 完成几何与变换计算。
- `scene_inspect`、`scene_get_features` 负责观察；对齐和落地工具计算定位提案。
- 修改工具的 `_meta["dai/placement"]` 携带 v2 绝对定位提案，查询不发布修改。
- 服务只读取授权项目的已保存 CAD 产物和 placement；不写项目、不修改 STEP 或 GLB。原生进程按次计算，取消/退出等待进程结束。

## 保存与显示

桌面在调用前验证目标为本轮项目和当前选中来源的最新显示产物；接管变换时验证来源 hash、revision 和有限坐标。成功变换随原生 Harness 工具结果保存，结果观察器才原子写入用户目录 `.daidai/projects/<projectId>/placements/<importId>.json`：

`{schemaVersion:2, importId, sourceHash, revision, translation:[x,y,z], rotation:[x,y,z,w]}`。

revision 使用已提交生产条目的 ID，不另建版本生成器；重复/旧条目不覆盖新状态，基准不匹配明确拒绝。文件是插件和桌面共同读取的当前整机定位，桌面为唯一写入者。启动先恢复显示索引，再从成功工具结果恢复 placement；失败或取消不发布变换。后续工具调用前等待前次索引落地。

`display.get` 附带 placement，仍通过 display.changed 通知前端。视口外层组应用平移与四元数，原 displayToScene 和对象局部变换不变；相机重新适应，GPU 模型无需重载。新 importId 默认原始坐标，同 importId 切聊天或重启复用保存位置。前端的高亮/透明度仍仅为查看状态。

## Skill

`scene-alignment` 描述角点、底部居中、特征/轴对齐的语义区别；按用户意图选择角点归零、参考系对齐或显式旋转。中文“角点归零/最小角点对齐原点”映射到 alignment_align_min_corner。含糊请求先澄清；不凭截图猜数值，不用临时 CAD 句柄，不导入或重新网格化已有模型。已经对齐时返回不变的绝对 translation，重复归零不累加偏移；相对旋转则由 expectedRevision 防止盲目重试。

## 验收

覆盖多级变换、重复实例、部分网格、负坐标、非零 placement、重复归零；变换前后对象相对关系不变。使用真实 Harness→stdio→C++→成功结果保存→Electron 回显，重启及同来源切聊天保持定位；拒绝错项目/版本/损坏资源，取消不遗留进程。

## 旋转与参考系对齐（已实现）

### 数据与职责

Alignment 只读已授权 importId 对应的清单、GLB、[CAD 特征缓存](cad-mcp.md#9-可离线读取的对齐参照已实现) 和当前 placement。不接收活 document，不依赖 CAD 进程，不要求原 STEP 仍存在；源文件变化时继续明确操作已保存版本。C++ 负责特征坐标转换、参考系求解和网格包围盒计算；TS 继续仅协议、文件授权与原生进程管理。模型选择对齐含义和参照，不手算最终四元数。

| 数据 | 定义 |
| --- | --- |
| DirectionRef | kind:model_axis/world_axis/cad_feature；轴类型使用 axis:X/Y/Z，world_axis 表示当前世界轴并由 C++ 换算；cad_feature 使用 objectId、featureId；reverse? 决定方向符号。无关字段禁止，按 kind 校验必填 |
| PointRef | kind:model_point/cad_feature；前者使用 position 三元数组，处于原模型坐标；后者使用 objectId、featureId，由 C++ 从对象局部转换到原模型坐标 |
| TargetFrame | origin、up、forward 三元数组，均在世界空间；米、右手 Z-up |
| Placement v2 | schemaVersion:2、importId、sourceHash、revision、translation、rotation:[x,y,z,w]；整机绝对刚体变换，scale 固定不变 |

原模型坐标为应用原装配层级后的 CAD Z-up 空间，尚未应用 Placement。GLB 顶点需先经 displayToScene 转换；CAD 特征沿清单局部变换解析，不能再次套用 GLB 的坐标转换。特征参照必须属于同一导入包；DirectionRef 只接受实际具备方向的特征，PointRef 只接受有明确位置的特征。不从平面/圆柱的无向轴自动推断设备“正前方”，方向不明确时让模型结合用户意图选择或澄清。

### 工具输入输出

以下为当前 API；复用现有服务扩展，不增加定位工作流服务。inputSchema 使用普通 object、字符串 enum、同类型定长数组，不使用数组 items 元组、复杂联合或新模型 adapter；按 kind 的字段互斥与数值几何条件在 C++ 校验。

共同类型与字段：

| 字段/类型 | 定义 |
| --- | --- |
| importId | 当前项目已发布导入包的字符串身份，由 scene-context 提供；服务读取绑定项目的资源，不由模型指定任意文件路径 |
| expectedRevision | 非负安全整数，本次计算基于的定位版本；未定位为 0，后续沿用 Harness 成功生产条目 ID |
| Vec3 / Quaternion | Vec3 为三个有限数；Quaternion 为四个有限数，顺序 x/y/z/w 且为单位四元数 |
| RigidTransform | translation:Vec3、rotation:Quaternion；绝对原模型→世界变换，不含新 scale |
| Bounds | min:Vec3、max:Vec3；默认世界轴对齐显示网格包围盒，不是精确 B-Rep 包围盒 |
| 状态快照 | placement:RigidTransform、bounds:Bounds；before/after 使用相同的整机世界空间和米制单位 |

| 工具 | 输入 | 成功输出 |
| --- | --- | --- |
| alignment_get_bounds | importId:string 必填；objectId:string 可选，缺省查询整机，指定则包含该对象后代 | importId、sourceHash、revision、objectId?、unit:m、space:world、boundsKind:display-mesh、placement、bounds、warnings |
| alignment_align_min_corner | importId:string 必填；expectedRevision:integer 可选以兼容旧客户端，新调用须显式传入 | 共同修改结果；保持当前 rotation，只平移使整机世界 AABB 最小角点归零 |
| alignment_align_frame | importId:string、expectedRevision:integer、sourceUp:DirectionRef、sourceForward:DirectionRef、anchor:string enum、target:TargetFrame 必填；sourceOrigin:PointRef 条件必填 | 共同修改结果，另附 resolvedSourceFrame、resolvedTargetFrame、usedReferences；同时求整机绝对旋转与平移 |
| alignment_rotate | importId:string、expectedRevision:integer、axis:Vec3、angleDegrees:number、pivot:Vec3、space:world/model 全部必填 | 共同修改结果；正角度按右手定则，axis 与 pivot 同属指定空间 |
| alignment_align_direction | importId、expectedRevision、sourceDirection:DirectionRef、targetDirection:Vec3、pivot | 最小旋转；返回实际方向、角度与旋转枢轴 |
| alignment_ground | importId、expectedRevision、groundZ、contacts（1–4 个 objectId/featureId） | 保持旋转和 X/Y，只沿世界 Z 平移；附每个水平接触面的前后高度 |
| scene_inspect | importId、offset?、limit?、objectIds?、order:lowest? | 对象分页、当前边界与定位；lowest 按对象世界最低 Z 排序并返回其边界 |
| scene_get_features | importId、objectIds（1–4 个）、type?、offset?、limit? | 按对象分页返回世界空间特征，含原点、方向和精确 featureId |
| scene_find_features | importId、type?、worldAxis?、minAbsCos?、minWorldZ?、maxWorldZ?、offset?、limit? | 跨对象筛选平面中心或圆柱轴，返回世界空间的几何特征、总数和下一页，以及显示/特征缓存完整性 |

修改工具的成功 data 统一为 `{importId, sourceHash, baseRevision, unit:"m", boundsKind:"display-mesh", before, after, warnings}`。baseRevision 为计算时读取的定位版本；显式传入 expectedRevision 时两者相等。after.placement 是计算所得绝对变换，不是增量，也不包含尚未产生的新 revision。参考系对齐另附的 resolved 帧均为实际采用的单位正交基，usedReferences 列出真实使用的 CAD 特征；模型轴由输入和 resolved 帧表达，供模型核对。get_bounds 的 bounds 可为指定对象范围；修改结果的 before/after 始终覆盖整机。

MCP 成功使用 structuredContent `{ok:true,data}`，content 提供有界摘要；失败使用 `{ok:false,error:{code,message}}` 和 isError:true，不附 placement 提案。领域错误包括未知/未授权导入、资源无效、版本冲突、对象/特征不存在、缺少缓存、退化参考系、无可显示顶点；不把失败降级为另一种对齐。标准协议错误与取消沿用 SDK，不另建 Alignment job/get_job/wait 接口。

min_corner/bottom_center 基于显示网格，必须标记近似来源；reference 必须提供 sourceOrigin，不接受以缺失参照退化为角点。axis 为非零三元方向，pivot 为米制三元点，space 同时规定二者的空间。目标 API 的 expectedRevision 由 currentDisplay/查询取得；旧 min_corner 调用缺省时只在服务端捕获当前 revision 以兼容已有协议，新增 Skill 总是显式传递。

参考系对齐是绝对求解：先将 sourceUp/sourceForward 构成右手正交基，将 forward 投影到垂直于 up 的平面；近零、平行或严重不一致的输入明确失败，不任意补一条轴。target 同样校验，C++ 求旋转 R。reference 使用 `t = target.origin - R × sourceOrigin`。角点/底部居中先按 R 变换顶点，再在 target 基下计算 AABB 并选择锚点，平移使锚点到达 target.origin；不能直接旋转旧 AABB 得到最终角点。常规世界 target 为 origin=(0,0,0)、up=(0,0,1)、forward=(1,0,0)，由模型明确传入。

重复绝对对齐不累加变换；rotate 则基于指定 revision 增量计算，最终仍返回绝对结果。过期 revision 重新读取；超时或接受结果未知时先核对当前已保存状态，不盲目重试一次旋转。误差容限、有限坐标、单位四元数、正交性和行列式必须验证，不接受缩放/镜像/剪切。所有操作保持零件相对位置、对象 ID 和原始颜色。

### 提交、兼容与显示

新结果沿用 `_meta["dai/placement"]`，v2 提案包含 schemaVersion:2、importId、sourceHash、expectedRevision、translation、rotation。计算工具不写项目；Harness 成功结果提交后，桌面生成 revision 并写用户目录的 `projects/<projectId>/placements/<importId>.json`，通知前端。提案准备失败、取消或版本冲突不覆盖已保存定位；不修改不可变 artifacts，也不让前端另外生成一份场景产物。

该元数据仅由修改工具提供，translation/rotation 与 after.placement 一致；只读查询不提供修改元数据。工具成功表示计算成功，不等于已保存或已渲染；后续 scene-context/get_bounds 返回的 revision 用于确认当前已提交状态。read 复用 Pi，文件入口由桌面上下文提供，不另增 alignment_read_file、alignment_get_scene 或 alignment_save 工具。

兼容同时覆盖旧 schemaVersion:1 定位文件，以及没有 schemaVersion/rotation 的旧 Harness placement 结果：按旧契约解码为单位四元数后走同一恢复路径。新 v2 缺 rotation 必须失败，不静默当作旧版；原生历史条目不改写，只有派生定位文件可升级。恢复仍按全局生产条目顺序和 expectedRevision 链，不另建版本库。

视口只应用新绝对根变换；详见 [前端设计](../frontend_spec/frontend.md#8-旋转回显与后续模型观察)。模型可直接执行用户已要求的对齐；预览仅在用户需要时设计，不作为固定确认关卡。验收包括旋转后角点归零、任意 pivot、重复绝对对齐、连续旋转版本冲突、旧文件/历史恢复、CAD 已释放及源文件缺失下继续定位，不能只验证数值输出而不验证实际渲染。

## 当前目标与错误恢复

`scene_inspect` 是 Alignment MCP 的只读工具；C++ worker 读取已保存的 manifest、显示网格与缓存特征，返回分页对象、整机世界显示边界，按需返回指定对象的边界与前五个缓存特征。特征属于对象局部坐标，不作语义排名。服务返回当前 placement/revision，并在查询期间发生定位变更时报告版本冲突；不修改模型或定位。

`scene_inspect` 的 `order=lowest` 按世界 Z 最低位置列出有显示网格的对象及其世界边界，供模型结合视图寻找地脚；边界不能证明对象的业务含义。`scene_get_features` 接收最多四个对象，按类型分页返回特征原点和方向的世界坐标；C++ 应用对象层级和当前 placement，不重复应用 GLB 坐标转换。

`scene_find_features` 面向跨对象的只读候选查询。worldAxis 和 minAbsCos 按方向与指定世界轴夹角的余弦绝对值筛选（默认 0.95，正负方向均可），minWorldZ / maxWorldZ 比较特征原点而非几何极值。返回的平面和圆柱仅是几何线索，不能单独证明业务用途；缓存或显示不完整时不可假定候选集完整。每次查询都校验当前定位版本，返回的 objectId/featureId 可供后续只读检查或明确授权的定位操作使用。

`alignment_ground` 接收当前 revision、地面 Z 和一至四个已识别的水平 CAD 接触面，保持旋转和 X/Y 平移，仅调整 Z，使最低接触面到达地面。结果列出每个接触面前后的高度；如果接触面不共高，其他接触面仍可能悬空，不能声称全部落地。非水平面返回明确错误，包围盒不替代地脚接触面。

`alignment_align_direction` 将模型轴、当前世界轴或缓存 CAD 特征方向变换到世界空间，再以最小角度旋转到指定的世界目标方向。枢轴可为当前显示包围盒中心或明确的世界点。它不指定前方向，也不自动落地；相反方向的 180 度情况使用确定性的垂直旋转轴。结果包含解析后的方向、轴、角度、枢轴和实际使用的特征。版本和保存流程与其他定位操作一致。

桌面每次调用校验当前导入身份。请求历史 importId 时返回 SCENE_TARGET_CHANGED，并附当前 scene 快照供模型以正确参数另行调用；不会自动改写 importId 或执行旧请求。read 路径不属于当前模型时同样提供最新可读文件入口。初始定位 revision 为 0，placement 文件尚不存在也是有效状态。

仅旋转整机不需要 CAD 精确特征。明确的世界轴穿过世界原点；轴、角度及枢轴确定后，可直接使用上下文中的 importId/revision 调用 alignment_rotate。不要通过重新导入修复目标过期，也不要为已知参数的旋转遍历清单、圆心或轴线。真正依赖缺失 CAD 特征的操作才说明需要显式重新导入。

连续操作：REVISION_CONFLICT 的标准错误响应可附 currentPlacement（完整 PlacementSchema），指明实际保存的版本和姿态。它不表示本次修改已执行；调用方根据最新状态重新决策，不能静默更换 expectedRevision 或重放相对旋转。
