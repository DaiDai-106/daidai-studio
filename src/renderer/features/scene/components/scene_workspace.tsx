import { lazy, Suspense, useState } from "react";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";
import type { SceneJointPreview, SceneRobot, SceneSelection } from "../../../../contracts/scene.ts";
import { Icon } from "../../../shared/components/icon.tsx";
import { useSceneWorkspace } from "../logic/use_scene_workspace.ts";
import { SceneInspector, type SceneTarget } from "./scene_inspector.tsx";
import { SceneTree } from "./scene_tree.tsx";
import "../styles/scene.css";

const SceneCanvas = lazy(async () => ({
  default: (await import("./scene_canvas.tsx")).SceneCanvas,
}));
const SceneCoordinates = lazy(async () => ({
  default: (await import("./scene_coordinates.tsx")).SceneCoordinates,
}));

type SceneView = "scene" | "source";
type ViewState = {
  modelRevision: number;
  view: SceneView;
  showProperties: boolean;
  selections: Partial<Record<SceneView, { selection: SceneSelection; picked: boolean }>>;
};
const initialView = { view: "scene", showProperties: false, selections: {} } as const;
const panes = [
  ["scene", "构建场景"],
  ["source", "原始模型"],
  ["properties", "属性"],
] as const;

function findTarget(
  robot: SceneRobot | null | undefined,
  selection?: SceneSelection,
): SceneTarget | undefined {
  if (!robot || !selection) return;
  if (selection.entity === "joint") {
    const node = robot.joints.find(({ id }) => id === selection.id);
    if (node) return { entity: "joint", node };
  } else {
    const node = robot.links.find(({ id }) => id === selection.id);
    if (node) return { entity: "link", node };
  }
}

export function SceneWorkspace({ projectId, api }: { projectId: string; api: ApplicationBridge }) {
  const scene = useSceneWorkspace(projectId, api);
  const { snapshot, modelRevision } = scene;
  const document = snapshot?.document;
  const sceneRobot = document?.robot;
  const revision = document?.revision ?? 0;
  const [state, setState] = useState<ViewState>({ ...initialView, modelRevision });
  const [preview, setPreview] = useState<SceneJointPreview & { revision: number }>();
  const { view } = state;
  const selections = state.modelRevision === modelRevision ? state.selections : {};
  const readOnly = view === "source";
  const robot = readOnly ? document?.sourceRobot : sceneRobot;
  const warnings = readOnly
    ? (document?.sourceWarnings ?? (robot ? document?.warnings : []))
    : document?.warnings;
  const [notice, ...notes] = new Set(warnings);
  const selected = selections[view];
  const pickedTarget = findTarget(robot, selected?.selection);
  const highlightedLink =
    pickedTarget?.entity === "joint" ? pickedTarget.node.childId : pickedTarget?.node.id;
  const defaultLink = readOnly
    ? robot?.joints.find(({ parentId }) => parentId === robot.rootLinkId)?.childId
    : robot?.rootLinkId;
  const target =
    pickedTarget ??
    (defaultLink ? findTarget(robot, { entity: "link", id: defaultLink }) : undefined);
  const active = target && { entity: target.entity, id: target.node.id };
  const showProperties = state.showProperties && Boolean(active);
  const livePreview =
    preview?.revision === revision && active?.entity === "joint" && preview.jointId === active.id
      ? preview
      : undefined;

  function setPane(pane: (typeof panes)[number][0]) {
    if (pane === "properties") {
      setState({ ...state, showProperties: true });
      return;
    }
    setPreview(undefined);
    setState({ ...state, view: pane, showProperties: false });
  }

  function select(selection: SceneSelection, picked = false) {
    setPreview(undefined);
    setState({
      ...state,
      modelRevision,
      selections: { ...selections, [view]: { selection, picked } },
    });
  }

  return (
    <section id="scene-workspace" className="scene-workspace" aria-label="场景工作区">
      <header className="scene-toolbar">
        <strong title={sceneRobot?.name}>
          <Icon name="box" size={16} />
          <span>{sceneRobot?.name ?? "场景搭建"}</span>
        </strong>
        {(["step", "urdf"] as const).map((format) => (
          <button
            key={format}
            type="button"
            disabled={!snapshot || scene.busy}
            onClick={() => void scene.importModel(format)}
          >
            导入 {format.toUpperCase()}
          </button>
        ))}
        <button
          type="button"
          disabled={!sceneRobot || scene.busy}
          onClick={() => void scene.exportUrdf()}
        >
          导出 URDF
        </button>
        <button
          type="button"
          disabled={!snapshot?.canUndo || scene.busy}
          onClick={() => void scene.apply({ op: "undo" })}
        >
          撤销
        </button>
      </header>
      {scene.stepImporting && (
        <div className="scene-notice">
          <span role="status">正在读取 STEP 装配…</span>{" "}
          <button type="button" onClick={() => void scene.cancelStep()}>
            取消导入
          </button>
        </div>
      )}
      {scene.error && (
        <p className="scene-notice error" role="alert">
          {scene.error}
        </p>
      )}
      {scene.exportPath && (
        <p className="scene-notice" role="status">
          已导出至 {scene.exportPath}
        </p>
      )}
      {snapshot?.legacy && (
        <p className="scene-notice" role="status">
          检测到旧版场景。可重新导入 STEP 或 URDF，旧模型数据会保留。
        </p>
      )}
      {notice &&
        (notes.length ? (
          <details className="scene-notice">
            <summary>
              {notice}（另有 {notes.length} 条导入说明）
            </summary>
            <ul>
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="scene-notice" role="status">
            {notice}
          </p>
        ))}
      {document ? (
        <div className="scene-stage">
          <aside className="scene-outliner">
            <fieldset className="scene-mode-controls" aria-label="装配视图">
              {panes.map(([pane, label]) => (
                <button
                  key={pane}
                  type="button"
                  aria-pressed={pane === (showProperties ? "properties" : view)}
                  disabled={pane === "properties" && !active}
                  onClick={() => setPane(pane)}
                >
                  {label}
                </button>
              ))}
            </fieldset>
            {robot && target && active ? (
              <>
                <SceneTree
                  key={`${modelRevision}:${view}`}
                  robot={robot}
                  selection={active}
                  picked={selected?.picked && pickedTarget ? selected.selection : undefined}
                  readOnly={readOnly}
                  hidden={showProperties}
                  onSelect={select}
                />
                <div className="scene-properties" hidden={!showProperties}>
                  {!readOnly && (
                    <SceneInspector
                      key={`${modelRevision}:${active.id}`}
                      revision={revision}
                      rootLinkId={robot.rootLinkId}
                      target={target}
                      busy={scene.busy}
                      apply={scene.apply}
                      preview={livePreview?.position}
                      onPreview={(position) =>
                        setPreview(
                          position === undefined
                            ? undefined
                            : { jointId: active.id, position, revision },
                        )
                      }
                    />
                  )}
                  {showProperties && (
                    <Suspense fallback={null}>
                      <SceneCoordinates robot={robot} selection={active} />
                    </Suspense>
                  )}
                </div>
              </>
            ) : (
              readOnly && (
                <div className="scene-source-empty">
                  <p role="status">
                    {sceneRobot ? "当前场景缺少原始模型快照。" : "导入 STEP 后可查看原始装配。"}
                  </p>
                  {sceneRobot && (
                    <button
                      type="button"
                      disabled={scene.busy}
                      onClick={() => void scene.importModel("step-source")}
                    >
                      补充原始 STEP
                    </button>
                  )}
                </div>
              )
            )}
          </aside>
          {robot ? (
            <Suspense
              fallback={
                <p className="scene-empty" role="status">
                  正在加载 3D 画布…
                </p>
              }
            >
              <SceneCanvas
                projectId={projectId}
                api={api}
                robot={robot}
                selected={highlightedLink ?? null}
                preview={livePreview}
                onSelect={(id) => select({ entity: "link", id }, true)}
              />
            </Suspense>
          ) : readOnly ? (
            <div className="scene-view" />
          ) : (
            <p className="scene-empty" role="status">
              导入 STEP 查看 CAD 装配，或导入已有的 URDF 模型。
            </p>
          )}
        </div>
      ) : (
        <p className="scene-empty" role="status">
          {scene.error ? "场景无法打开。" : "正在读取场景…"}
        </p>
      )}
    </section>
  );
}
