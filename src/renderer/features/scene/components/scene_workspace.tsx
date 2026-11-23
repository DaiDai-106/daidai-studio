import { type CSSProperties, lazy, Suspense, useCallback, useMemo, useState } from "react";
import type { ApplicationBridge } from "../../../../contracts/bridge.ts";
import type { SceneJointPreview, SceneRobot, SceneSelection } from "../../../../contracts/scene.ts";
import { resolveSceneRobot } from "../../../../shared/scene/geometry.ts";
import {
  sceneVisualOpacities,
  selectionTransparency,
  transparencyTargets,
} from "../../../../shared/scene/transparency.ts";
import { Icon } from "../../../shared/components/icon.tsx";
import { PaneSplitter } from "../../../shared/components/pane_splitter.tsx";
import { useSceneWorkspace } from "../logic/use_scene_workspace.ts";
import { SceneInspector, type SceneTarget } from "./scene_inspector.tsx";
import { SceneSourceInspector } from "./scene_source_inspector.tsx";
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
  view: SceneView;
  selections: Partial<
    Record<SceneView, { revision: number; selection: SceneSelection; picked: boolean }>
  >;
};
const panes = [
  ["scene", "构建场景"],
  ["source", "原始模型"],
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
  const sourceRevision = snapshot?.sourceRevision ?? 0;
  const [state, setState] = useState<ViewState>({ view: "scene", selections: {} });
  const [canvasWidth, setCanvasWidth] = useState(55);
  const [stageWidth, setStageWidth] = useState(0);
  const measureStage = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    setStageWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStageWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const minSidebarWidth = Math.min(210, stageWidth * 0.4);
  const maxSidebarWidth = Math.min(480, stageWidth * 0.65);
  const minCanvasWidth = stageWidth ? (1 - maxSidebarWidth / stageWidth) * 100 : 35;
  const maxCanvasWidth = stageWidth ? (1 - minSidebarWidth / stageWidth) * 100 : 72;
  const actualCanvasWidth = Math.max(minCanvasWidth, Math.min(maxCanvasWidth, canvasWidth));
  const [preview, setPreview] = useState<SceneJointPreview & { revision: number }>();
  const [opacityDraft, setOpacityDraft] = useState<{
    revision: number;
    selectionKey: string;
    value: number;
  }>();
  const [checked, setChecked] = useState<{ sourceRevision: number; ids: string[] }>({
    sourceRevision,
    ids: [],
  });
  const checkedIds = useMemo(
    () => (checked.sourceRevision === sourceRevision ? checked.ids : []),
    [checked, sourceRevision],
  );
  const resolvedRobot = useMemo(() => (document ? resolveSceneRobot(document) : null), [document]);
  const { view, selections } = state;
  const readOnly = view === "source";
  const viewRevision = readOnly ? sourceRevision : modelRevision;
  const robot = readOnly ? document?.sourceRobot : sceneRobot;
  const warnings = Array.from(new Set(readOnly ? document?.sourceWarnings : document?.warnings));
  const selected = selections[view]?.revision === viewRevision ? selections[view] : undefined;
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
  const sourceIds = checkedIds.length
    ? checkedIds
    : target?.entity === "link"
      ? [target.node.id]
      : [];
  const opacityEntity = readOnly ? "source" : "link";
  const pickedId = pickedTarget?.node.id;
  const opacityIds = useMemo(
    () =>
      readOnly
        ? checkedIds.length
          ? checkedIds
          : pickedId
            ? [pickedId]
            : []
        : highlightedLink
          ? [highlightedLink]
          : [],
    [readOnly, checkedIds, pickedId, highlightedLink],
  );
  const opacitySelectionKey = JSON.stringify([viewRevision, opacityEntity, opacityIds]);
  const opacityTargets = useMemo(
    () =>
      document && opacityIds.length ? transparencyTargets(document, opacityEntity, opacityIds) : [],
    [document, opacityEntity, opacityIds],
  );
  const savedOpacity = document
    ? selectionTransparency(document, opacityTargets)
    : { value: 0, mixed: false };
  const activeOpacityDraft =
    opacityDraft?.revision === revision && opacityDraft.selectionKey === opacitySelectionKey
      ? opacityDraft
      : undefined;
  const transparency = activeOpacityDraft?.value ?? savedOpacity.value;
  const visualOpacities = useMemo(
    () =>
      document
        ? sceneVisualOpacities(
            document,
            readOnly,
            activeOpacityDraft
              ? opacityTargets.map((target) => ({ ...target, value: activeOpacityDraft.value }))
              : [],
          )
        : new Map(),
    [document, readOnly, activeOpacityDraft, opacityTargets],
  );
  const livePreview =
    preview?.revision === revision &&
    sceneRobot?.joints.some((joint) => joint.id === preview.jointId)
      ? preview
      : undefined;

  function setPane(pane: (typeof panes)[number][0]) {
    setPreview(undefined);
    setState({ ...state, view: pane });
  }

  function select(selection: SceneSelection, picked = false) {
    setPreview(undefined);
    setState({
      ...state,
      selections: { ...selections, [view]: { revision: viewRevision, selection, picked } },
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
      {warnings.length > 0 && (
        <details className="scene-notice scene-import-warnings" aria-label="导入警告" key={view}>
          <summary>导入警告（{warnings.length}）</summary>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      {document ? (
        <div
          ref={measureStage}
          className="scene-stage"
          style={{ "--scene-canvas-width": `${actualCanvasWidth}%` } as CSSProperties}
        >
          <aside className="scene-outliner">
            <fieldset className="scene-mode-controls" aria-label="装配视图">
              {panes.map(([pane, label]) => (
                <button
                  key={pane}
                  type="button"
                  aria-pressed={pane === view}
                  onClick={() => setPane(pane)}
                >
                  {label}
                </button>
              ))}
            </fieldset>
            {robot && target && active ? (
              <>
                <SceneTree
                  key={`${viewRevision}:${view}`}
                  robot={robot}
                  selection={active}
                  picked={selected?.picked && pickedTarget ? selected.selection : undefined}
                  readOnly={readOnly}
                  checkedIds={readOnly ? checkedIds : undefined}
                  onCheck={
                    readOnly
                      ? (id, value) =>
                          setChecked({
                            sourceRevision,
                            ids: value
                              ? [...checkedIds, id]
                              : checkedIds.filter((item) => item !== id),
                          })
                      : undefined
                  }
                  onSelect={(selection) => {
                    setChecked({ sourceRevision, ids: [] });
                    select(selection);
                  }}
                />
                <div className="scene-properties">
                  <strong className="scene-properties-header">属性 · URDF 配置</strong>
                  {readOnly ? (
                    <>
                      <div className="scene-source-selection">
                        <div className="scene-source-property-name" title={target.node.name}>
                          {target.node.name}
                        </div>
                        {checkedIds.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setChecked({ sourceRevision, ids: [] })}
                          >
                            清空多选
                          </button>
                        )}
                      </div>
                      <SceneSourceInspector
                        key={`${sourceRevision}:${sourceIds.join(",")}`}
                        document={document}
                        sourceIds={sourceIds}
                        busy={scene.busy}
                        apply={scene.apply}
                        preview={livePreview}
                        onPreview={(value) => setPreview(value && { ...value, revision })}
                      />
                    </>
                  ) : (
                    <SceneInspector
                      key={`${modelRevision}:${active.id}`}
                      revision={revision}
                      robot={robot}
                      target={target}
                      busy={scene.busy}
                      apply={scene.apply}
                      preview={livePreview?.position}
                      onPreview={(position) =>
                        setPreview(
                          position === undefined
                            ? undefined
                            : {
                                jointId:
                                  target.entity === "joint"
                                    ? target.node.id
                                    : (robot.joints.find(
                                        (joint) => joint.childId === target.node.id,
                                      )?.id ?? ""),
                                position,
                                revision,
                              },
                        )
                      }
                    />
                  )}
                  <details className="scene-config-group" open={!readOnly}>
                    <summary>{readOnly ? "原始 CAD 坐标（搭建参照）" : "坐标变换"}</summary>
                    <Suspense fallback={null}>
                      <SceneCoordinates robot={robot} selection={active} readOnly={readOnly} />
                    </Suspense>
                  </details>
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
          <PaneSplitter
            className="scene-panel-splitter"
            label="调整属性与画布宽度"
            width={actualCanvasWidth}
            min={minCanvasWidth}
            max={maxCanvasWidth}
            onWidth={(change) =>
              setCanvasWidth(typeof change === "function" ? change(actualCanvasWidth) : change)
            }
            unit="percent"
          />
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
                robot={readOnly ? robot : (resolvedRobot ?? robot)}
                transparency={transparency}
                opacities={visualOpacities}
                transparencyMixed={!activeOpacityDraft && savedOpacity.mixed}
                transparencyDisabled={scene.busy || !opacityTargets.length}
                onTransparencyChange={(value) =>
                  setOpacityDraft({ revision, selectionKey: opacitySelectionKey, value })
                }
                onTransparencyCommit={() => {
                  if (activeOpacityDraft && !scene.busy)
                    void scene
                      .apply(
                        {
                          op: "setTransparency",
                          entity: opacityEntity,
                          ids: opacityIds,
                          value: activeOpacityDraft.value,
                        },
                        activeOpacityDraft.revision,
                      )
                      .finally(() => setOpacityDraft(undefined));
                }}
                onTransparencyCancel={() => setOpacityDraft(undefined)}
                selected={highlightedLink ?? null}
                preview={readOnly ? undefined : livePreview}
                onSelect={(id) => {
                  setChecked({ sourceRevision, ids: [] });
                  select({ entity: "link", id }, true);
                }}
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
