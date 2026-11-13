import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const python =
  process.env.DAI_SCENE_TEST_PYTHON ??
  join(
    homedir(),
    ".dai",
    "python",
    "scene",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
if (!existsSync(python)) {
  console.error(
    `场景测试需要已安装的 Python 环境：${python}。请设置 DAI_SCENE_TEST_PYTHON，或先安装场景依赖。`,
  );
  process.exitCode = 1;
} else {
  const env = { ...process.env, DAI_SCENE_TEST_PYTHON: python };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  function run(command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`测试进程失败：${signal ?? code}`)),
      );
    });
  }
  try {
    await run(python, [
      "-c",
      "import vtkmodules.vtkCommonCore; from OCP.STEPCAFControl import STEPCAFControl_Reader; from OCP.BRepMesh import BRepMesh_IncrementalMesh",
    ]);
    await run(python, ["tests/runners/test_scene_python.py"]);
    await run(process.execPath, [
      "tests/runners/test_runner.mjs",
      "tests/packages/*.test.ts",
      "tests/backend/scene/scene*workflow.test.ts",
      "tests/backend/scene/cylinder_workflow.test.ts",
      "tests/backend/scene/distance*.test.ts",
      "tests/backend/scene/scene_deletion.test.ts",
      "tests/backend/scene/scene_paths.test.ts",
      "tests/backend/scene/python_service.test.ts",
      "tests/backend/scene/python_service_concurrency.test.ts",
    ]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
