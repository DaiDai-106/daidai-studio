# STEP 解析器

`cad-import` 读取自包含的 STEP 装配，输出父子关系、局部变换、颜色和二进制 STL。同一几何定义的多个实例共用网格。场景工作区和 Agent 共用解析器，画布预览和 URDF 导出共用生成的网格。 [Open CASCADE STEP 文档](https://occt3d.com/dev/doc/overview/html/occt_user_guides__step.html)

## 构建

安装 CMake 3.24 或更新版本及本机 C++ 工具链。Linux 使用 GCC，macOS 使用 Xcode 命令行工具，Windows 使用 Visual Studio 的 C++ 桌面开发工具。首次构建会下载固定版本的源码并编译 OCCT。在仓库根目录运行以下命令。

```bash
npm run build:scene
```

已有 OCCT 7.9.3 开发包时，可直接配置 `modules/scene`，用 `OpenCASCADE_DIR` 指向存放 `OpenCASCADEConfig.cmake` 的目录。用于发版的入口在 `modules/scene/cmake`，负责构建并随应用分发固定版本的 OCCT。

## 命令行

`npm run build:scene` 将解析器和运行库安装到 `modules/scene/runtime`。可直接运行解析器，Windows 上程序名为 `cad-import.exe`。

```bash
modules/scene/runtime/cad-import robot.step assembly-output
```

手动解析使用 GBK 编码的旧 STEP 时，可在命令末尾加 `--gbk`。桌面端会根据文件头的名称识别这类文件。

`assembly-output` 必须是新目录。`assembly.json` 使用版本 1，`occurrences` 按父节点优先排列。`origin.xyz` 以米表示，`origin.rpy` 以弧度表示并遵循 URDF 的 RPY 约定。STL 保留毫米单位，预览和 URDF 都应用 `0.001` 的缩放。

`omissions` 记录网格化跳过的曲面及其零件。整件零件没有可用三角面时终止导入，当前场景保持原模型。最大输入为 128 MiB，单个 STL 上限为 8 MiB，整套 STL 上限为 48 MiB。带外部零件引用的装配需在 CAD 中重新导出为自包含 STEP。

## 第三方依赖与许可

- Dai Studio 的 STEP 解析器动态链接 Open CASCADE Technology 7.9.3，采用 GNU LGPL 2.1 及 Open CASCADE 例外条款。 [OCCT 7.9.3 源码](https://github.com/Open-Cascade-SAS/OCCT/tree/V7_9_3)
- JSON 读写使用 nlohmann/json 3.12.0，采用 MIT 许可证。随库头文件的版权声明包括 Niels Lohmann、Evan Nemerson（2016–2021）、Björn Hoehrmann（2008–2009）、The Abseil Authors（2018）和 Florian Loitsch（2009）。 [nlohmann/json 3.12.0 源码](https://github.com/nlohmann/json/tree/v3.12.0)

安装包的 `modules/scene/runtime/licenses/` 随包提供本页及上游的 `LICENSE_LGPL_21.txt`、`OCCT_LGPL_EXCEPTION.txt` 和 `LICENSE.MIT`。

## 验证

```bash
npm run build:scene
npm run build
node tests/runners/test_runner.mjs 'tests/backend/scene/*.test.ts' 'tests/renderer/scene/*.test.ts' \
  tests/integration/scene_workspace_ui.test.ts tests/integration/step_workspace_ui.test.ts
```
