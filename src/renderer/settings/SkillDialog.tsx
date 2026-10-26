import { useState } from "react";
import { Dialog, Field, Notice } from "../components/Dialog.tsx";
import type { Project, Skill } from "../types.ts";
import { ScopeFields } from "./ConnectionFields.tsx";

const skillExample =
  "---\nname: step-review\ndescription: 查看选中 STEP 的原始结构与单位。\n---\n\n# STEP 检查\n\n先读取选中的 STEP，再根据真实结果报告对象结构、单位和警告。";

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
  onSave: (skill: Skill) => void;
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
  const [importingNow, setImportingNow] = useState(importing);
  const [error, setError] = useState("");
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
    setDraft({ ...draft, name, description, body });
    setSource("");
    setImportingNow(false);
    setError("");
  }
  return (
    <Dialog
      title={
        draft.builtin ? "查看内置技能" : importing ? "导入技能" : skill ? "编辑技能" : "新建技能"
      }
      onClose={onClose}
      protectChanges={!draft.builtin}
    >
      <Notice>
        {skill?.builtin
          ? "内置说明来自随应用提供的 SKILL.md；工具权限由业务模式单独配置。"
          : "技能会按所选项目与模式加载，并从下一轮对话生效。Skill 不会单独授予工具权限。"}
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
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <Field label="用途描述">
            <input
              maxLength={1000}
              readOnly={draft.builtin}
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
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
              onScope={(scope) => setDraft({ ...draft, scope })}
              onModes={(modes) => setDraft({ ...draft, modes })}
            />
          )}
          <Field label="Markdown 正文">
            <textarea
              className="code-input"
              maxLength={32000}
              readOnly={draft.builtin}
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            />
          </Field>
          <div className="dialog-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                if (draft.builtin)
                  onSave({
                    ...draft,
                    id: crypto.randomUUID(),
                    name: `${draft.name}-copy`,
                    builtin: false,
                  });
                else if (
                  !draft.name.trim() ||
                  !draft.description.trim() ||
                  !draft.body.trim() ||
                  !draft.modes.length
                )
                  setError("名称、用途、正文和至少一个适用模式均为必填。");
                else
                  onSave({
                    ...draft,
                    name: draft.name.trim(),
                    description: draft.description.trim(),
                    body: draft.body.trim(),
                  });
              }}
            >
              {draft.builtin ? "复制为自定义技能" : "保存技能"}
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
