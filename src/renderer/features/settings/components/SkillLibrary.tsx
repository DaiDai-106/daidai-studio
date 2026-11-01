import { useEffect, useState } from "react";
import type { ManagedSkill } from "../../../../contracts/application.ts";
import { Dialog, Field } from "../../../shared/components/Dialog.tsx";
import type { Project } from "../../../shared/logic/types.ts";
import "../styles/skill.css";

type Editor = { name: string; text: string; mode: "create" | "edit" | "view" };

export function SkillLibrary({ project }: { project: Project | undefined }) {
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const projectId = project?.id;
  useEffect(() => {
    let active = true;
    setSkills([]);
    setError("");
    void window.desktop.application
      .listSkills(projectId)
      .then((items) => {
        if (active) setSkills(items);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "读取技能失败。");
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  async function change(action: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await action();
      setSkills(await window.desktop.application.listSkills(projectId));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "技能操作失败。");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function open(skill: ManagedSkill) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const text = await window.desktop.application.readSkillDocument(skill.id, projectId);
      setEditor({ name: skill.name, text, mode: skill.editable ? "edit" : "view" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取技能失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="settings-section capability-section"
      aria-labelledby="skill-library-heading"
    >
      <header className="capability-section-heading">
        <div>
          <h2 id="skill-library-heading">技能</h2>
          <p>使用标准 SKILL.md。内置和包内技能只读。</p>
        </div>
        <div className="button-group">
          <button
            type="button"
            disabled={busy}
            onClick={() => void change(() => window.desktop.application.importSkillDirectory())}
          >
            导入技能目录
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditor({ name: "", text: "", mode: "create" })}
          >
            新建技能
          </button>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {!skills.length && !error && <p>暂无可用技能。</p>}
      {skills.map((skill) => (
        <div key={skill.id} className="setting-row">
          <div>
            <strong>{skill.name}</strong>
            <p>{skill.description}</p>
            <small>
              {skill.source === "user"
                ? "用户"
                : skill.source === "builtin"
                  ? "内置 · 只读"
                  : "扩展包 · 只读"}
            </small>
          </div>
          <button type="button" disabled={busy} onClick={() => void open(skill)}>
            {skill.editable ? "编辑" : "查看"}
          </button>
        </div>
      ))}
      {editor && (
        <Dialog
          title={
            editor.mode === "create" ? "新建技能" : editor.mode === "edit" ? "编辑技能" : "查看技能"
          }
          onClose={() => setEditor(null)}
          wide
          protectChanges
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (editor.mode === "view") return;
              const request = { name: editor.name.trim(), text: editor.text };
              void change(() =>
                editor.mode === "create"
                  ? window.desktop.application.createSkillDocument(request)
                  : window.desktop.application.saveSkillDocument(request),
              ).then((saved) => {
                if (saved) setEditor(null);
              });
            }}
          >
            <Field label="技能名称">
              <input
                value={editor.name}
                disabled={editor.mode !== "create"}
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                placeholder="小写字母、数字和连字符"
              />
            </Field>
            <Field label="SKILL.md">
              <textarea
                className="skill-document"
                value={editor.text}
                readOnly={editor.mode === "view"}
                onChange={(event) => setEditor({ ...editor, text: event.target.value })}
                placeholder={"---\nname: example\ndescription: 技能说明\n---\n\n# 技能步骤"}
              />
            </Field>
            {error && <p role="alert">{error}</p>}
            <div className="dialog-actions">
              <button type="button" onClick={() => setEditor(null)}>
                关闭
              </button>
              {editor.mode !== "view" && (
                <button
                  type="submit"
                  className="primary"
                  disabled={busy || !editor.name.trim() || !editor.text.trim()}
                >
                  保存
                </button>
              )}
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
