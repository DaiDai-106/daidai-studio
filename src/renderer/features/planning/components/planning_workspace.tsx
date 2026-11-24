import { useRef, useState } from "react";
import { ActionMenu } from "../../../shared/components/action_menu.tsx";
import { Dialog, Field } from "../../../shared/components/dialog.tsx";
import { Icon } from "../../../shared/components/icon.tsx";
import { Select } from "../../../shared/components/select.tsx";
import { errorMessage } from "../../../shared/logic/error_message.ts";
import { loadPlanningScene, type PlanningScene, sceneFilePath } from "../logic/planning_scene.ts";
import { PlanningCanvas } from "./planning_canvas.tsx";
import "../../scene/styles/scene.css";
import "../styles/planning.css";

const processes = [
  { value: "bevel", label: "坡口切割" },
  { value: "weld", label: "焊接" },
  { value: "steel", label: "型钢切割" },
  { value: "custom", label: "非标" },
] as const;

export function PlanningWorkspace() {
  const [scene, setScene] = useState<PlanningScene>();
  const [process, setProcess] = useState<(typeof processes)[number]["value"]>("bevel");
  const [loading, setLoading] = useState(false);
  const [importError, setImportError] = useState("");
  const [packageFiles, setPackageFiles] = useState<{ files: File[]; urdfs: File[] }>();
  const [urdfChoice, setUrdfChoice] = useState("");
  const urdfInput = useRef<HTMLInputElement>(null);
  const packageInput = useRef<HTMLInputElement>(null);

  async function importUrdf(urdf: File, files: File[]) {
    setLoading(true);
    setImportError("");
    try {
      setScene(await loadPlanningScene(urdf, files));
    } catch (cause) {
      setImportError(errorMessage(cause, "无法加载规划场景。"));
    } finally {
      setLoading(false);
    }
  }

  function chooseFiles(files: File[]) {
    if (!files.length) return;
    const urdfs = files.filter((file) => /\.urdf$/iu.test(file.name));
    const first = urdfs[0];
    if (!first) setImportError("未找到 URDF 文件。");
    else if (urdfs.length === 1) void importUrdf(first, files);
    else {
      setUrdfChoice(sceneFilePath(first));
      setPackageFiles({ files, urdfs });
    }
  }

  return (
    <section className="scene-workspace" aria-label="规划工作区">
      <header className="scene-toolbar">
        <strong title={scene?.name}>
          <Icon name="box" size={16} />
          <span>{scene?.name ?? "规划"}</span>
        </strong>
        <Select aria-label="工艺" value={process} options={processes} onValueChange={setProcess} />
        <ActionMenu
          label="加载场景"
          trigger={
            <button type="button" disabled={loading}>
              加载场景 <Icon name="chevron-down" size={13} />
            </button>
          }
          actions={[
            { label: "选择 URDF 文件", onSelect: () => urdfInput.current?.click() },
            { label: "选择 Package 目录", onSelect: () => packageInput.current?.click() },
          ]}
        />
        <button type="button" disabled>
          运行规划
        </button>
      </header>
      <input
        ref={urdfInput}
        type="file"
        aria-label="规划 URDF 文件"
        accept=".urdf,.stl"
        multiple
        hidden
        onChange={(event) => {
          chooseFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={packageInput}
        type="file"
        aria-label="规划 Package 目录"
        {...{ webkitdirectory: "" }}
        hidden
        onChange={(event) => {
          chooseFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      {importError && (
        <p className="scene-notice error" role="alert">
          {importError}
        </p>
      )}
      {loading && (
        <p className="scene-notice" role="status">
          正在加载场景…
        </p>
      )}
      {scene?.warnings.length ? (
        <details className="scene-notice scene-import-warnings">
          <summary>场景显示提示（{scene.warnings.length}）</summary>
          <ul>
            {scene.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="planning-stage">
        <aside className="scene-outliner planning-outliner" aria-label="轨迹结果">
          <h3>轨迹结果</h3>
          <p>规划引擎待接入</p>
        </aside>
        {scene ? (
          <PlanningCanvas scene={scene} />
        ) : !loading ? (
          <p className="scene-empty" role="status">
            请加载 URDF 文件或 Package 目录。
          </p>
        ) : null}
      </div>
      {packageFiles && (
        <Dialog title="选择主 URDF" onClose={() => setPackageFiles(undefined)}>
          <Field label="URDF 文件">
            <select
              value={urdfChoice}
              onChange={(event) => setUrdfChoice(event.currentTarget.value)}
            >
              {packageFiles.urdfs.map((file) => (
                <option key={sceneFilePath(file)}>{sceneFilePath(file)}</option>
              ))}
            </select>
          </Field>
          <div className="dialog-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                const urdf = packageFiles.urdfs.find((file) => sceneFilePath(file) === urdfChoice);
                if (urdf) void importUrdf(urdf, packageFiles.files);
                setPackageFiles(undefined);
              }}
            >
              加载
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
