# 场景 Runtime

本文说明场景 Python 环境的安装与部署；Runtime、场景数据、限制和验收见 [场景 Runtime 设计](design/scene_runtime.md)。

以下 `python/` 路径均相对于 `packages/scene/`。

## Python 环境

目前实测 Linux x86_64、Python 3.12。目标机器需要 Python 3.12 的 `venv` 模块和支持 `--python` 的 pip；准备好后执行：

```sh
python3.12 packages/scene/python/install.py --data-root "$HOME/.dai"
```

脚本在数据根创建 `python/scene` 虚拟环境，仅安装 `python/requirements.txt` 中固定版本的二进制 wheels 并验证动态库；已存在的目录不会被覆盖。安装失败或正常终止时会回滚本次新建环境。之后 Linux/macOS 使用 `<数据根>/python/scene/bin/python`，Windows 使用 `<数据根>/python/scene/Scripts/python.exe`，以 `pythonExecutable` 传入 Runtime。若已经有包含指定依赖的 Python 环境，也可直接指定该环境的解释器。

离线部署可预先在目标平台准备依赖对应的 wheels，然后添加 `--wheelhouse <目录>`，脚本将使用 `--no-index` 安装。不要复制已创建的虚拟环境：venv 通常包含创建位置和基础 Python 的绝对路径，应在目标位置创建。Linux 以外的平台及离线打包尚需实际验证其 Python 版本、wheel 与动态库。

发布应用时，需要把 `python/worker.py`、`python/geometry.py`、`python/gltf.py`、`python/distance.py`、`python/install.py` 和 `python/requirements.txt` 作为磁盘上的 unpacked 资源随应用发布，并通过 `workerPath` 显式传入 worker 路径。场景资源接管和读取当前依赖 Linux 的目录句柄与 `/proc/self/fd`；macOS 和 Windows 会拒绝场景导入或资源读取，详见 [场景 Runtime 的平台限制](design/scene_runtime.md#暂存写入和平台限制)。

## 验证

运行 `npm run test:scene` 检查依赖并执行 Python 几何和 Node 场景测试；解释器默认位于用户主目录的 `~/.dai/python/scene`，可用 `DAI_SCENE_TEST_PYTHON` 覆盖。使用 `DAI_SCENE_TEST_WHEELHOUSE` 可额外执行离线安装回归。测试入口和环境要求见 [测试与验收](design/testing.md)。
