import { useMemo, useRef, useState } from "react";
import { ActionMenu } from "../components/ActionMenu.tsx";
import { Icon, IconButton } from "../components/Icon.tsx";
import { ObjectTree } from "../scene/ObjectTree.tsx";
import { SceneViewport } from "../scene/SceneViewport.tsx";
import type { CameraView, ModelViewOverrides, ViewportHandle } from "../scene/types.ts";
import { useImportedModel } from "../scene/useImportedModel.ts";

const views: { id: CameraView; label: string }[] = [
  { id: "isometric", label: "等轴视图" },
  { id: "front", label: "前视图" },
  { id: "right", label: "右视图" },
  { id: "top", label: "顶视图" },
];
const noTransparency: Readonly<Record<string, number>> = {};

// Viewing controls remain independent of CAD editing and task execution.
export function ScenePanel({
  concealed,
  step,
  conversationId,
  sourceId,
}: {
  concealed: boolean;
  step: string;
  conversationId: string;
  sourceId: string;
}) {
  const viewport = useRef<ViewportHandle>(null);
  const [grid, setGrid] = useState(true);
  const [axes, setAxes] = useState(true);
  const [tree, setTree] = useState(true);
  const [overrides, setOverrides] = useState<ModelViewOverrides | null>(null);
  const display = useImportedModel(conversationId, sourceId);
  const loaded = display.loaded;
  const importId = loaded?.importId;
  const view = overrides?.importId === importId ? overrides : null;
  const selected = view?.selectedId ?? null;
  const transparency = view?.transparency ?? noTransparency;
  const objects = useMemo(
    () => new Map(loaded?.manifest.objects.map((object) => [object.objectId, object])),
    [loaded],
  );
  const selection = selected ? objects.get(selected) : undefined;
  function setSelected(selectedId: string | null) {
    setOverrides((previous) => ({
      importId: importId ?? "",
      selectedId,
      transparency: previous && previous.importId === importId ? previous.transparency : {},
    }));
  }
  function transparencyFor(id: string): number {
    for (let object = objects.get(id); object; object = objects.get(object.parentObjectId ?? "")) {
      const value = transparency[object.objectId];
      if (value !== undefined) return value;
    }
    return 0;
  }
  function setTransparency(value: number) {
    if (!selected || !importId) return;
    setOverrides((previous) => {
      const values = previous?.importId === importId ? { ...previous.transparency } : {};
      // Applying a parent value replaces child overrides so the whole assembly responds.
      for (const id of Object.keys(values)) {
        for (
          let object = objects.get(id);
          object;
          object = objects.get(object.parentObjectId ?? "")
        ) {
          if (object.objectId === selected) {
            delete values[id];
            break;
          }
        }
      }
      values[selected] = value;
      return { importId, selectedId: selected, transparency: values };
    });
  }
  const transparencyPercent = selection ? Math.round(transparencyFor(selection.objectId) * 100) : 0;
  return (
    <section className="scene-panel" aria-label="场景工作区" hidden={concealed}>
      <header className="scene-heading">
        <span>
          <Icon name="box" size={16} />
          场景视图
        </span>
        <span className="muted">Z ↑ · 米</span>
      </header>
      {step && (
        <div className="scene-source">
          <Icon name="file" size={13} />
          <span>{step}</span>
        </div>
      )}
      <div className="scene-toolbar">
        <IconButton
          icon="layers"
          label={tree ? "隐藏对象树" : "显示对象树"}
          onClick={() => setTree(!tree)}
        />
        <ActionMenu
          label="选择视角"
          trigger={
            <button type="button" className="text-button">
              视角
              <Icon name="chevron-down" size={12} />
            </button>
          }
          actions={views.map((view) => ({
            label: view.label,
            onSelect: () => viewport.current?.setView(view.id),
          }))}
        />
        <IconButton icon="fit" label="适应视图" onClick={() => viewport.current?.fit()} />
        <button
          type="button"
          className="text-button"
          aria-pressed={grid}
          onClick={() => setGrid(!grid)}
        >
          网格
        </button>
        <button
          type="button"
          className="text-button"
          aria-pressed={axes}
          onClick={() => setAxes(!axes)}
        >
          坐标轴
        </button>
      </div>
      {display.sourceStatus && display.sourceStatus !== "current" && (
        <p className="scene-version-note">
          {display.sourceStatus === "changed"
            ? "STEP 已变化，当前显示上次保存的模型。"
            : "源 STEP 不可用，当前显示上次保存的模型。"}
        </p>
      )}
      {loaded && !loaded.manifest.complete && (
        <p
          className="scene-version-note"
          role="status"
          title="未通过显示校验的面未绘制，原始 CAD 几何和诊断仍然保留。"
        >
          部分显示 ·{" "}
          {loaded.manifest.omittedFaceCount
            ? `${loaded.manifest.omittedFaceCount} 个 CAD 面未显示`
            : "部分对象无可显示网格"}
        </p>
      )}
      <div
        className="scene-stage"
        data-scene-loaded={loaded ? "true" : "false"}
        data-display-status={display.status}
        data-import-id={importId ?? ""}
      >
        <SceneViewport
          ref={viewport}
          showGrid={grid}
          showAxes={axes}
          model={loaded?.root ?? null}
          selectedId={selected}
          transparency={transparency}
          onPick={setSelected}
        />
        {loaded && (tree || selection) && (
          <aside className="scene-object-panel" aria-label="对象列表">
            {tree && (
              <>
                <span className="scene-object-count">对象 · {loaded.manifest.objects.length}</span>
                <ObjectTree
                  key={loaded.importId}
                  manifest={loaded.manifest}
                  selected={selected}
                  onSelect={setSelected}
                />
              </>
            )}
            {selection && (
              <fieldset className="scene-object-properties" aria-label="对象查看属性">
                <strong title={selection.name}>{selection.name || "未命名对象"}</strong>
                <div className="scene-transparency-label">
                  <span>透明度</span>
                  <output>{transparencyPercent}%</output>
                  <button type="button" className="text-button" onClick={() => setTransparency(0)}>
                    重置
                  </button>
                </div>
                <input
                  type="range"
                  aria-label="对象透明度"
                  aria-valuetext={`${transparencyPercent}%`}
                  min={0}
                  max={100}
                  step={1}
                  value={transparencyPercent}
                  onChange={(event) => setTransparency(Number(event.target.value) / 100)}
                />
              </fieldset>
            )}
          </aside>
        )}
        {!loaded && display.status === "empty" && (
          <div className="scene-empty-hint">
            <h2>场景从这里开始</h2>
            <p>{step ? "已选择 STEP，可在右侧对话中请求导入。" : "在聊天栏选择项目中的 STEP。"}</p>
          </div>
        )}
        {display.status === "loading" && (
          <div className="scene-loading" role="status">
            正在加载已保存模型…
          </div>
        )}
        {display.error && (
          <div className="viewport-error" role="alert">
            {display.error}{" "}
            <button type="button" className="text-button" onClick={display.reload}>
              重新加载
            </button>
          </div>
        )}
        {selection && (
          <div className="scene-selection" role="status">
            已选择：{selection.name || "未命名对象"}
          </div>
        )}
      </div>
    </section>
  );
}
