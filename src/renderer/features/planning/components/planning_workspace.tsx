import { useEffect, useState } from "react";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";
import type { PlanningScene, PlanningSource } from "../../../../contracts/planning.ts";
import { ActionMenu } from "../../../shared/components/action_menu.tsx";
import { Icon } from "../../../shared/components/icon.tsx";
import { Select } from "../../../shared/components/select.tsx";
import { errorMessage } from "../../../shared/logic/error_message.ts";
import { PlanningCanvas } from "./planning_canvas.tsx";
import "../../robot/styles/robot.css";
import "../styles/planning.css";

const processes = [
  { value: "bevel", label: "坡口切割" },
  { value: "weld", label: "焊接" },
  { value: "steel", label: "型钢切割" },
  { value: "custom", label: "非标" },
] as const;
const sceneViews = [
  { value: "visual", label: "视觉模型" },
  { value: "collision", label: "碰撞模型" },
] as const;

export function PlanningWorkspace({
  api,
  projectId,
}: {
  api: ApplicationBridge;
  projectId: string;
}) {
  const [scene, setScene] = useState<PlanningScene>();
  const [sceneView, setSceneView] = useState<(typeof sceneViews)[number]["value"]>("visual");
  const [process, setProcess] = useState<(typeof processes)[number]["value"]>("bevel");
  const [loading, setLoading] = useState(true);
  const [importError, setImportError] = useState("");
  useEffect(() => {
    let current = true;
    let receivedUpdate = false;
    const unsubscribe = api.subscribe((event) => {
      if (event.type !== "planning.scene" || event.projectId !== projectId) return;
      receivedUpdate = true;
      const { snapshot } = event;
      // 进程退出时保留已显示的模型和相机。
      setScene((current) =>
        snapshot.status === "stale" && current?.revision === snapshot.revision
          ? { ...current, status: "stale" }
          : snapshot,
      );
      if (snapshot.status === "loaded") setImportError("");
    });
    void api
      .getPlanningScene(projectId)
      .then(
        (snapshot) => {
          if (current && !receivedUpdate && snapshot) setScene(snapshot);
        },
        (cause) => {
          if (current && !receivedUpdate) setImportError(errorMessage(cause, "无法读取规划场景。"));
        },
      )
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [api, projectId]);

  async function loadScene(kind: PlanningSource) {
    setLoading(true);
    setImportError("");
    try {
      await api.loadPlanningScene(projectId, kind);
    } catch (cause) {
      setImportError(errorMessage(cause, "无法加载规划场景。"));
    } finally {
      setLoading(false);
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
        <Select
          aria-label="场景显示"
          value={sceneView}
          options={sceneViews}
          onValueChange={setSceneView}
          disabled={!scene}
        />
        <ActionMenu
          label="加载场景"
          trigger={
            <button type="button" disabled={loading}>
              加载场景 <Icon name="chevron-down" size={13} />
            </button>
          }
          actions={[
            { label: "选择 URDF 文件", onSelect: () => void loadScene("urdf") },
            { label: "选择 Package 目录", onSelect: () => void loadScene("package") },
          ]}
        />
        <button type="button" disabled>
          运行规划
        </button>
      </header>
      {importError && (
        <p className="scene-notice error" role="alert">
          {importError}
        </p>
      )}
      {scene?.status === "stale" && (
        <p className="scene-notice" role="status">
          One Punch 规划进程已停止。当前保留上一次场景，请重新加载。
        </p>
      )}
      {loading && (
        <p className="scene-notice" role="status">
          正在加载场景…
        </p>
      )}
      {sceneView === "collision" && scene?.collisionGeometry.length === 0 && (
        <p className="scene-notice" role="status">
          此场景没有碰撞几何。
        </p>
      )}
      <div className="planning-stage">
        <aside className="scene-outliner planning-outliner" aria-label="轨迹结果">
          <h3>轨迹结果</h3>
          <p>轨迹规划待接入</p>
        </aside>
        {scene ? (
          <PlanningCanvas
            scene={scene}
            projectId={projectId}
            api={api}
            showCollision={sceneView === "collision"}
          />
        ) : !loading ? (
          <p className="scene-empty" role="status">
            请加载 URDF 文件或 Package 目录。
          </p>
        ) : null}
      </div>
    </section>
  );
}
