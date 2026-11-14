import { useEffect, useState } from "react";
import type { ManagedSkill } from "../../../../contracts/application.ts";
import type { PluginModule, PluginScope } from "../../../../contracts/catalog.ts";
import { Dialog, Field } from "../../../shared/components/dialog.tsx";
import { errorMessage } from "../../../shared/logic/error_message.ts";
import { Empty } from "./plugin_presentation.tsx";
import "../styles/skill.css";

type Editor = { name: string; text: string; mode: "create" | "edit" | "view" };

export function SkillLibrary({
  moduleId = "coding",
  userOnly = false,
  packageSource,
  packageScope,
}: {
  moduleId?: PluginModule;
  userOnly?: boolean;
  packageSource?: string;
  packageScope?: PluginScope;
}) {
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const visible = skills.filter(
    (skill) =>
      (!userOnly || skill.source === "user") &&
      (!packageSource || skill.ownerSource === packageSource) &&
      (!packageScope || skill.ownerScope === packageScope) &&
      `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  useEffect(() => {
    let active = true;
    let request = 0;
    setSkills([]);
    const refresh = async () => {
      const version = ++request;
      setError("");
      try {
        const items = await window.desktop.application.listSkills(moduleId, userOnly);
        if (active && version === request) setSkills(items);
      } catch (cause) {
        if (active && version === request) setError(errorMessage(cause, "读取技能失败。"));
      }
    };
    void refresh();
    // 同版本更新也可能改变技能内容；按实际任务刷新，不依赖版本号变化。
    const unsubscribe = window.desktop.application.subscribe((event) => {
      if (
        !userOnly &&
        event.type === "catalog.task" &&
        event.task.host === "pi" &&
        event.task.state !== "running" &&
        (event.task.scope === "global" ||
          event.task.action === "update" ||
          event.task.moduleId === moduleId)
      )
        void refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [moduleId, userOnly]);

  // 读取和写入共用提交状态；只有写入成功后才刷新列表。
  async function run(action: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch (cause) {
      setError(errorMessage(cause, "技能操作失败。"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function change(action: () => Promise<unknown>) {
    return run(async () => {
      await action();
      setSkills(await window.desktop.application.listSkills(moduleId, userOnly));
    });
  }

  function open(skill: ManagedSkill) {
    return run(async () => {
      const text = await window.desktop.application.readSkillDocument(skill.id, moduleId);
      setEditor({ name: skill.name, text, mode: skill.editable ? "edit" : "view" });
    });
  }
  return (
    <section
      className="settings-section capability-section skill-library"
      aria-labelledby="skill-library-heading"
    >
      <header className="capability-section-heading">
        <div>
          <h2 id="skill-library-heading">{userOnly ? "我的技能" : "技能"}</h2>
          <p>
            {packageSource
              ? "插件附带的技能，随插件一起管理。"
              : "把常用的方法和步骤保存为技能，让 Dai 按你的方式工作。"}
          </p>
        </div>
        {!packageSource && (
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
        )}
      </header>
      <label className="plugin-search">
        <input
          aria-label="搜索我的技能"
          placeholder="搜索技能名称或说明…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!visible.length && !error && (
        <Empty
          icon={query ? "search" : "tool"}
          title={
            query ? "没有匹配的技能" : packageSource ? "这个插件没有附带技能" : "还没有自己的技能"
          }
        >
          <p>
            {query
              ? "换个关键词试试。"
              : packageSource
                ? "可以在插件说明中了解它提供的其他功能。"
                : "新建一个技能，或导入已有的技能目录。"}
          </p>
        </Empty>
      )}
      {visible.map((skill) => (
        <div key={skill.id} className="setting-row">
          <div>
            <strong>{skill.name}</strong>
            <p>{skill.description}</p>
            <small>{skill.source === "user" ? "我的技能" : "插件附带 · 只读"}</small>
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
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
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
