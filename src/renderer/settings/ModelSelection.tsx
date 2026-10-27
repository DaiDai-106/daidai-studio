import type { ModelChoice } from "../../shared/application.ts";
import { Field } from "../components/Dialog.tsx";

interface Props {
  catalog: ModelChoice[];
  selected: ModelChoice[];
  allowManual: boolean;
  filter: string;
  onFilter: (value: string) => void;
  modelId: string;
  onModelId: (value: string) => void;
  onChange: (models: ModelChoice[]) => void;
}

export function ModelSelection({
  catalog,
  selected,
  allowManual,
  filter,
  onFilter,
  modelId,
  onModelId,
  onChange,
}: Props) {
  function toggle(model: ModelChoice) {
    onChange(
      selected.some((item) => item.id === model.id)
        ? selected.filter((item) => item.id !== model.id)
        : [...selected, model],
    );
  }
  function update(
    id: string,
    change: Partial<Pick<ModelChoice, "context" | "output" | "supportsImages">>,
  ) {
    onChange(selected.map((model) => (model.id === id ? { ...model, ...change } : model)));
  }
  return (
    <>
      <Field label="筛选模型">
        <input
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          placeholder="搜索模型名称或 ID…"
        />
      </Field>
      <div className="model-catalog">
        {catalog
          .filter((model) =>
            `${model.id} ${model.name}`.toLowerCase().includes(filter.toLowerCase()),
          )
          .map((model) => (
            <label className="check-row" key={model.id}>
              <input
                type="checkbox"
                checked={selected.some((item) => item.id === model.id)}
                onChange={() => toggle(model)}
              />
              <span>
                {model.name}
                <small className="small muted"> · {model.id}</small>
              </span>
            </label>
          ))}
        {!catalog.length && (
          <p className="small muted">尚无目录。可读取服务目录或手动输入模型 ID。</p>
        )}
      </div>
      {allowManual && (
        <>
          <Field label="手动模型 ID">
            <input value={modelId} onChange={(event) => onModelId(event.target.value)} />
          </Field>
          <button
            type="button"
            disabled={!modelId.trim() || selected.some((item) => item.id === modelId.trim())}
            onClick={() => {
              onChange([
                ...selected,
                {
                  id: modelId.trim(),
                  name: modelId.trim(),
                  context: 131072,
                  output: 8192,
                  reasoning: "参数未验证",
                },
              ]);
              onModelId("");
            }}
          >
            添加模型
          </button>
        </>
      )}
      {selected.map((model) => (
        <div className="selected-model" key={model.id}>
          <strong>{model.name}</strong>
          {allowManual && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={model.supportsImages ?? false}
                onChange={(event) => update(model.id, { supportsImages: event.target.checked })}
              />
              支持图片输入
            </label>
          )}
          <div className="limit-inputs">
            <label>
              上下文窗口
              <input
                type="number"
                min="1024"
                aria-label={`${model.id} 上下文窗口`}
                value={model.context}
                onChange={(event) => update(model.id, { context: Number(event.target.value) })}
              />
            </label>
            <label>
              最大输出
              <input
                type="number"
                min="1"
                aria-label={`${model.id} 最大输出`}
                value={model.output}
                onChange={(event) => update(model.id, { output: Number(event.target.value) })}
              />
            </label>
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() => onChange(selected.filter((item) => item.id !== model.id))}
          >
            移除 {model.id}
          </button>
        </div>
      ))}
    </>
  );
}
