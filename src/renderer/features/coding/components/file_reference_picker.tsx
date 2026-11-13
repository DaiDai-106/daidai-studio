import { type Ref, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import type { FileReference } from "../../../../shared/file_references.ts";
import { Icon, IconButton } from "../../../shared/components/icon.tsx";
import { useFileSearch } from "../logic/use_file_search.ts";

export interface FileReferencePickerHandle {
  handleKey: (key: string) => boolean;
}

export function FileReferencePicker({
  ref,
  projectId,
  query,
  onSelect,
  onClose,
  onActiveOption,
}: {
  ref: Ref<FileReferencePickerHandle>;
  projectId: string;
  query: string;
  onSelect: (reference: FileReference) => void;
  onClose: () => void;
  onActiveOption: (id: string | undefined) => void;
}) {
  const { result, error } = useFileSearch(projectId, query);
  const [selection, setSelection] = useState({ query, index: 0 });
  const list = useRef<HTMLDivElement>(null);
  const optionId = useId();
  const paths = result?.paths ?? [];
  const index = selection.query === query ? Math.min(selection.index, paths.length - 1) : 0;
  useEffect(() => {
    list.current?.children[index]?.scrollIntoView({ block: "nearest" });
    onActiveOption(index >= 0 && paths.length ? `${optionId}-${index}` : undefined);
  }, [index, paths.length, onActiveOption, optionId]);
  useImperativeHandle(ref, () => ({
    handleKey(key) {
      if (key === "Escape") onClose();
      else if (key === "ArrowDown" || key === "ArrowUp")
        setSelection({
          query,
          index: paths.length
            ? (index + (key === "ArrowDown" ? 1 : -1) + paths.length) % paths.length
            : 0,
        });
      else if (key === "Enter" || key === "Tab") {
        const path = paths[index];
        if (path) onSelect({ path });
        else if (key === "Tab") return false;
      } else return false;
      return true;
    },
  }));

  return (
    <section className="file-reference-picker" aria-label="引用项目文件">
      <header>
        <span>项目文件</span>
        <IconButton icon="close" label="关闭文件引用选择" onClick={onClose} />
      </header>
      <div
        ref={list}
        className="file-reference-options"
        role="listbox"
        id="file-reference-options"
        aria-label="项目文件候选"
      >
        {paths.map((path, position) => (
          <button
            key={path}
            id={`${optionId}-${position}`}
            type="button"
            role="option"
            aria-label={path}
            aria-selected={position === index}
            tabIndex={-1}
            title={path}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect({ path })}
          >
            <Icon name="file" size={14} />
            <span>{path.split("/").pop()}</span>
            <small>
              {path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "项目根目录"}
            </small>
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !result ? (
        <p role="status">正在搜索…</p>
      ) : !paths.length ? (
        <p role="status">没有匹配文件。</p>
      ) : result.truncated ? (
        <p>继续输入以缩小范围</p>
      ) : null}
    </section>
  );
}
