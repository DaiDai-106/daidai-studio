import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, Field, Notice } from "../components/Dialog.tsx";
import type { Project, Skill } from "../types.ts";
import { ScopeFields } from "./ConnectionFields.tsx";
import { appendSkillImage, removeSkillImage } from "./skillImageDraft.ts";

const skillExample =
  "---\nname: step-review\ndescription: 查看选中 STEP 的原始结构与单位。\n---\n\n# STEP 检查\n\n先读取选中的 STEP，再根据真实结果报告对象结构、单位和警告。";
const sceneChoices = new Set(["steel-structure", "bevel-cutting", "welding", "robot-body"]);

export function SkillDialog({
  skill,
  importing,
  project,
  defaults,
  onSave,
  onClose,
}: {
  skill: Skill | null;
  importing: boolean;
  project: Project | undefined;
  defaults: Pick<Skill, "scope" | "modes">;
  onSave: (skill: Skill) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Skill>(
    skill ?? {
      id: crypto.randomUUID(),
      name: "",
      description: "",
      body: "",
      builtin: false,
      enabled: true,
      ...defaults,
    },
  );
  const [source, setSource] = useState("");
  const [customScene, setCustomScene] = useState(
    skill?.sceneProfile && !sceneChoices.has(skill.sceneProfile) ? skill.sceneProfile : "",
  );
  const [customSceneSelected, setCustomSceneSelected] = useState(
    !!skill?.sceneProfile && !sceneChoices.has(skill.sceneProfile),
  );
  const [importingNow, setImportingNow] = useState(importing);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const draftRef = useRef(draft);
  const temporaryImages = useRef(new Set<string>());
  const uploadQueue = useRef(Promise.resolve());
  const saveTask = useRef(Promise.resolve());
  const uploadCount = useRef(0);
  const mounted = useRef(true);
  const closing = useRef(false);
  const committed = useRef(false);
  const savingRef = useRef(false);

  draftRef.current = draft;

  function changeDraft(update: (current: Skill) => Skill) {
    const next = update(draftRef.current);
    draftRef.current = next;
    setDraft(next);
  }

  const removeTemporaryImage = useCallback(async (path: string) => {
    if (!temporaryImages.current.has(path)) return;
    await window.desktop.application.removeSkillImage(draftRef.current.id, path);
    temporaryImages.current.delete(path);
  }, []);

  const discardTemporaryImages = useCallback(async () => {
    const paths = [...temporaryImages.current];
    const results = await Promise.allSettled(paths.map((path) => removeTemporaryImage(path)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }, [removeTemporaryImage]);

  function beginSaving() {
    let finish: () => void = () => {};
    saveTask.current = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return finish;
  }

  async function close() {
    if (closing.current) return;
    if (savingRef.current) return;
    if (committed.current) {
      onClose();
      return;
    }
    closing.current = true;
    setCleaning(true);
    try {
      await uploadQueue.current;
      await discardTemporaryImages();
      onClose();
    } catch (reason) {
      closing.current = false;
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : "无法清理未保存的参考图片。");
    } finally {
      if (mounted.current) setCleaning(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Normal close awaits cleanup. This fallback covers an external unmount.
      if (!committed.current)
        void Promise.allSettled([uploadQueue.current, saveTask.current])
          .then(discardTemporaryImages)
          .catch(() => {});
    };
  }, [discardTemporaryImages]);
  useEffect(() => {
    let cancelled = false;
    for (const image of draft.images ?? []) {
      if (previews[image.path]) continue;
      void window.desktop.application
        .readSkillImage(draft.id, image.path)
        .then((value) => {
          if (!cancelled)
            setPreviews((items) => ({
              ...items,
              [image.path]: `data:${value.mimeType};base64,${value.data}`,
            }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [draft.id, draft.images, previews]);
  function addImages(files: File[]) {
    if (!files.length || closing.current) return;
    uploadCount.current++;
    setUploading(true);
    setError("");
    const upload = uploadQueue.current.then(async () => {
      for (const file of files) {
        if (closing.current) return;
        if ((draftRef.current.images?.length ?? 0) >= 30)
          throw new Error("每个技能最多添加 30 张参考图片。");
        if (
          !(["image/png", "image/jpeg", "image/webp"] as string[]).includes(file.type) ||
          file.size > 5 * 1024 * 1024
        )
          throw new Error("请选择不超过 5 MB 的 PNG、JPEG 或 WebP 图片。");
        const url = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("无法读取图片。"));
          reader.readAsDataURL(file);
        });
        if (closing.current) return;
        const image = await window.desktop.application.addSkillImage(
          draftRef.current.id,
          file.name.slice(0, 200),
          {
            mimeType: file.type as "image/png" | "image/jpeg" | "image/webp",
            data: url.slice(url.indexOf(",") + 1),
          },
        );
        temporaryImages.current.add(image.path);
        if (closing.current) {
          await removeTemporaryImage(image.path);
          return;
        }
        changeDraft((current) => appendSkillImage(current, image));
        setPreviews((items) => ({ ...items, [image.path]: url }));
      }
    });
    // Continue a later upload even if this one fails, while retaining the original rejection for UI.
    uploadQueue.current = upload.catch(() => {});
    void upload.then(
      () => {
        uploadCount.current--;
        if (mounted.current && uploadCount.current === 0) setUploading(false);
      },
      (reason) => {
        uploadCount.current--;
        if (mounted.current) {
          setError(reason instanceof Error ? reason.message : "无法添加图片。");
          if (uploadCount.current === 0) setUploading(false);
        }
      },
    );
  }
  function parse() {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source.trim());
    const metadata = match?.[1];
    const body = match?.[2]?.trim();
    const name = metadata
      ?.match(/^name:\s*(.+)$/m)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
    const description = metadata
      ?.match(/^description:\s*(.+)$/m)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
    if (!name || !description || !body) {
      setError("请提供 name、description 单行字段与非空 Markdown 正文。暂不支持复杂 YAML。");
      return;
    }
    changeDraft((current) => ({ ...current, name, description, body }));
    setSource("");
    setImportingNow(false);
    setError("");
  }

  async function removeImage(image: NonNullable<Skill["images"]>[number]) {
    changeDraft((current) => removeSkillImage(current, image));
    setPreviews((items) => {
      const next = { ...items };
      delete next[image.path];
      return next;
    });
    if (!temporaryImages.current.has(image.path)) return;
    setCleaning(true);
    try {
      await removeTemporaryImage(image.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法清理未保存的参考图片。");
    } finally {
      if (mounted.current) setCleaning(false);
    }
  }

  async function save() {
    if (savingRef.current) return;
    const value = draftRef.current;
    if (value.builtin) {
      savingRef.current = true;
      setSaving(true);
      const finish = beginSaving();
      try {
        if (
          await onSave({
            ...value,
            id: crypto.randomUUID(),
            name: `${value.name}-copy`,
            builtin: false,
          })
        ) {
          committed.current = true;
          temporaryImages.current.clear();
          onClose();
        } else setError("保存技能失败，请检查页面提示后重试。");
      } catch (reason) {
        if (mounted.current)
          setError(reason instanceof Error ? reason.message : "保存技能失败，请重试。");
      } finally {
        finish();
        savingRef.current = false;
        if (mounted.current) setSaving(false);
      }
      return;
    }
    if (
      !value.name.trim() ||
      !value.description.trim() ||
      !value.body.trim() ||
      !value.modes.length
    ) {
      setError("名称、用途、正文和至少一个适用模式均为必填。");
      return;
    }
    if (customSceneSelected && !customScene.trim()) {
      setError("请填写自定义场景名称。");
      return;
    }
    if (value.sceneProfile && !value.modes.includes("scene")) {
      setError("业务场景技能必须启用场景搭建模式。");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    const finish = beginSaving();
    setError("");
    try {
      // Paths removed from this draft must be gone before the skill becomes committed.
      const retained = new Set(value.images?.map((image) => image.path));
      for (const path of [...temporaryImages.current]) {
        if (!retained.has(path)) await removeTemporaryImage(path);
      }
      const saved = await onSave({
        ...value,
        name: value.name.trim(),
        description: value.description.trim(),
        body: value.body.trim(),
      });
      if (!saved) {
        setError("保存技能失败，请检查页面提示后重试。");
        return;
      }
      // Do not run unmount cleanup against files now referenced by the saved configuration.
      committed.current = true;
      temporaryImages.current.clear();
      onClose();
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : "保存技能失败，请重试。");
    } finally {
      finish();
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <Dialog
      title={
        draft.builtin ? "查看内置技能" : importing ? "导入技能" : skill ? "编辑技能" : "新建技能"
      }
      onClose={close}
      protectChanges={!draft.builtin}
    >
      <Notice>
        {skill?.builtin
          ? "内置说明来自随应用提供的 SKILL.md；工具权限由业务模式单独配置。"
          : "通用技能按所选项目与模式加载；业务场景技能在选择对应场景后加载。Skill 不会单独授予工具权限。"}
      </Notice>
      {importingNow ? (
        <>
          <Field label="SKILL.md 内容">
            <textarea
              className="code-input"
              value={source}
              placeholder={skillExample}
              onChange={(event) => setSource(event.target.value)}
            />
          </Field>
          <button type="button" className="text-button" onClick={() => setSource(skillExample)}>
            填入示例技能
          </button>
          <div className="dialog-actions">
            <button type="button" className="primary" onClick={parse}>
              解析并预览
            </button>
          </div>
        </>
      ) : (
        <>
          <Field label="技能名称">
            <input
              maxLength={100}
              readOnly={draft.builtin}
              value={draft.name}
              disabled={cleaning || saving}
              onChange={(event) => {
                const name = event.target.value;
                changeDraft((current) => ({ ...current, name }));
              }}
            />
          </Field>
          <Field label="用途描述">
            <input
              maxLength={1000}
              readOnly={draft.builtin}
              value={draft.description}
              disabled={cleaning || saving}
              onChange={(event) => {
                const description = event.target.value;
                changeDraft((current) => ({ ...current, description }));
              }}
            />
          </Field>
          {draft.builtin ? (
            <p className="small muted">
              内置技能 · 全局 · 场景搭建。可停用，或复制为自定义技能后编辑。
            </p>
          ) : (
            <ScopeFields
              scope={draft.scope}
              modes={draft.modes}
              project={project}
              onScope={(scope) => {
                if (!cleaning && !saving) changeDraft((current) => ({ ...current, scope }));
              }}
              onModes={(modes) => {
                if (!cleaning && !saving) changeDraft((current) => ({ ...current, modes }));
              }}
            />
          )}
          {!draft.builtin && (
            <Field label="业务场景（可选）">
              <select
                value={customSceneSelected ? "__custom__" : (draft.sceneProfile ?? "")}
                disabled={cleaning || saving}
                onChange={(event) => {
                  const custom = event.target.value === "__custom__";
                  setCustomSceneSelected(custom);
                  const value = custom ? customScene.trim() : event.target.value;
                  changeDraft((current) => {
                    const { sceneProfile: _previous, ...rest } = current;
                    return value ? { ...rest, sceneProfile: value } : rest;
                  });
                }}
              >
                <option value="">通用技能</option>
                <option value="steel-structure">型钢场景</option>
                <option value="bevel-cutting">坡口切割场景</option>
                <option value="welding">焊接场景</option>
                <option value="robot-body">机器人本体场景</option>
                <option value="__custom__">自定义场景</option>
              </select>
            </Field>
          )}
          {!draft.builtin && customSceneSelected && (
            <Field label="自定义场景名称">
              <input
                value={customScene}
                maxLength={100}
                disabled={cleaning || saving}
                onChange={(event) => {
                  const value = event.target.value;
                  setCustomScene(value);
                  changeDraft((current) => {
                    const { sceneProfile: _previous, ...rest } = current;
                    return value.trim() ? { ...rest, sceneProfile: value.trim() } : rest;
                  });
                }}
              />
            </Field>
          )}
          {!draft.builtin && draft.sceneProfile && (
            <>
              <Field label="参考图片">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  disabled={uploading || cleaning || saving}
                  onChange={(event) => {
                    addImages(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
              </Field>
              <p className="small muted">添加后会插入正文引用；模型需要时通过场景插件读取。</p>
              {(draft.images ?? []).map((image) => (
                <div key={image.path}>
                  {previews[image.path] && (
                    <img
                      src={previews[image.path]}
                      alt={image.name}
                      style={{ maxWidth: 160, maxHeight: 120 }}
                    />
                  )}
                  <span>{image.name}</span>{" "}
                  <button
                    type="button"
                    disabled={cleaning || saving}
                    onClick={() => void removeImage(image)}
                  >
                    移除
                  </button>
                </div>
              ))}
            </>
          )}
          <Field label="Markdown 正文">
            <textarea
              className="code-input"
              maxLength={32000}
              readOnly={draft.builtin}
              value={draft.body}
              disabled={cleaning || saving}
              onChange={(event) => {
                const body = event.target.value;
                changeDraft((current) => ({ ...current, body }));
              }}
            />
          </Field>
          <div className="dialog-actions">
            <button
              type="button"
              className="primary"
              disabled={uploading || cleaning || saving}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : draft.builtin ? "复制为自定义技能" : "保存技能"}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
