import { Field } from "../components/Dialog.tsx";
import { Select } from "../components/Select.tsx";
import type { CapabilityScope, Mode, Project } from "../types.ts";
import { modes } from "../workbench/modes.ts";

export function ScopeFields({
  scope,
  modes: selectedModes,
  project,
  onScope,
  onModes,
}: {
  scope: CapabilityScope;
  modes: Mode[];
  project: Project | undefined;
  onScope: (value: CapabilityScope) => void;
  onModes: (value: Mode[]) => void;
}) {
  return (
    <>
      <Field label="适用范围">
        <Select
          value={scope.kind === "global" ? "global" : scope.projectId}
          onValueChange={(value) =>
            onScope(value === "global" ? { kind: "global" } : { kind: "project", projectId: value })
          }
          options={[
            { value: "global", label: "全局" },
            ...(project ? [{ value: project.id, label: `项目：${project.name}` }] : []),
            ...(scope.kind === "project" && scope.projectId !== project?.id
              ? [{ value: scope.projectId, label: "原配置项目" }]
              : []),
          ]}
        />
      </Field>
      <fieldset className="mode-options">
        <legend>适用模式</legend>
        {modes.map((mode) => (
          <label key={mode.id}>
            <input
              type="checkbox"
              checked={selectedModes.includes(mode.id)}
              onChange={(event) =>
                onModes(
                  event.target.checked
                    ? [...selectedModes, mode.id]
                    : selectedModes.filter((item) => item !== mode.id),
                )
              }
            />
            {mode.label}
          </label>
        ))}
      </fieldset>
    </>
  );
}
