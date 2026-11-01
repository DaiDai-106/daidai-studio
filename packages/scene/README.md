# 场景 Runtime

Runtime 以项目 ID 区分，首次调用场景工具时启动 Python worker；不同会话可复用同一个项目的 Runtime。`scene_import` 的路径必须先经桌面端文件选择器或拖拽授权，worker 不负责授权和项目状态提交。

同一项目的 worker 请求按提交顺序串行执行。取消排队任务只取消该任务；取消正在运行的任务会停止该项目 worker，并在后续任务到来时重建，不会取消队列中其他会话的任务。不同项目各自拥有独立的 worker。

worker 默认空闲五分钟后退出；有执行中或排队的任务时不会按空闲回收。Runtime 对象和磁盘中的项目场景继续保留，下次调用会重新启动该项目的 worker。

每条 worker JSON 响应上限为 8 MiB（按 UTF-8 字节计算）；超限会停止该 worker 并报告失败，不提交场景。其他当前限制包括 STEP 源文件 256 MiB、装配对象 100,000 个、输出 GLB 256 MiB 和独立几何网格 2,000,000 个三角形。元数据上限可能先于对象数量上限触发；更大的装配需要后续改为受控文件或分页传输。

## Python 环境

目前实测 Linux x86_64、Python 3.12。目标机器需要 Python 3.12 的 `venv` 模块和支持 `--python` 的 pip；准备好后执行：

```sh
python3.12 packages/scene/python/install.py --data-root "$HOME/.dai"
```

脚本在数据根创建 `python/scene` 虚拟环境，仅安装 `python/requirements.txt` 中固定版本的二进制 wheels 并验证动态库；已存在的目录不会被覆盖。安装失败或正常终止时会回滚本次新建环境。之后 Linux/macOS 使用 `$HOME/.dai/python/scene/bin/python`，Windows 使用 `<数据根>/python/scene/Scripts/python.exe`，以 `pythonExecutable` 传入 Runtime。若已经有包含指定依赖的 Python 环境，也可直接指定该环境的解释器。

离线部署可预先在目标平台准备依赖对应的 wheels，然后添加 `--wheelhouse <目录>`，脚本将使用 `--no-index` 安装。不要复制已创建的虚拟环境：venv 通常包含创建位置和基础 Python 的绝对路径，应在目标位置创建。Linux 以外的平台及离线打包尚需实际验证其 Python 版本、wheel 与动态库。

发布应用时，需要把 `python/worker.py`、`python/geometry.py`、`python/gltf.py`、`python/distance.py`、`python/install.py` 和 `python/requirements.txt` 作为磁盘上的 unpacked 资源随应用发布，并通过 `workerPath` 显式传入 worker 路径。场景导入需要可用的 POSIX 目录句柄；Windows 当前会安全拒绝导入，macOS 尚未实机验证。

## 导入和验证

`scene_import` 保留 STEP 原路径，生成的 GLB 暂存于项目数据目录 `staging/`，调用方负责校验、提升为持久资源并原子提交场景记录。XCAF 导入保留装配节点、实例变换、重复几何及可导出的颜色。运动结构、复杂文件和全部几何修复尚未验证，返回 `complete: false` 与警告。

Python 根据 OCCT 网格直接编码 GLB，使用独占打开的文件句柄写入，不让 OCCT 按路径打开暂存文件。目录通过 POSIX 目录句柄逐级打开，系统缺少所需能力时拒绝导入。256 MiB 的 GLB 上限不是进程内存上限：OCCT 网格、数组和输出缓冲需要额外内存，大模型仍可能内存不足。

叶对象的 `geometryBounds` 基于导入时的几何计算，是对象自身 STEP 坐标系的米制轴对齐边界与尺寸，不包含对象或祖先的实例变换。不同实例可共享同一几何边界；装配容器不提供持久边界，避免子对象修改后产生过期数据。这是与导入时源文件哈希对应的快照，并不会在源 STEP 改动后自动刷新。

导入时还会识别解析几何为圆柱面的候选：记录局部坐标中的无限轴线上一点、单位方向和米制半径，并通过 `scene_get_cylinders` 分页访问。它们只提供几何证据，关节是否存在、类型和运动约束均未知；每个几何最多保留 64 项，每次导入最多 4096 项，超出会标记截断。

`scene_compare_cylinder_axes` 按项目当前版本比较两个对象的世界轴线，返回角度、第二条轴线参考点到第一条无限轴线的偏距和半径差；阈值由调用者明确指定。即使在容差内也不能推断真实机械连接、关节类型或限位。

世界边界查询按项目当前局部位姿和父级变换，把局部包围盒八个顶点转换到前端 Z-up 世界坐标（米），得到保守包围盒；旋转后其边界不一定与精确几何最小边界一致。对齐原点操作把这个保守盒的最小角移动至世界原点并保持局部旋转。非叶对象、缺少可信变换信息或包含缩放的层级会明确拒绝。GLB 内部遵循 glTF 的 Y-up，前端加载时使用外层旋转恢复 Z-up。

运行 `npm run test:scene` 可依次检查依赖、执行 Python 几何测试和 Node 场景回归。通过 `DAI_SCENE_TEST_PYTHON` 指定测试解释器；默认使用 `~/.dai/python/scene`。缺少解释器或 OCP/VTK 时命令失败，空测试或全部跳过也不会被视为通过。使用 `DAI_SCENE_TEST_WHEELHOUSE` 可额外执行离线安装回归。
