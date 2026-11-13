import { useContext } from "react";
import type { FileReference } from "../../../../shared/file_references.ts";
import { Icon } from "../../../shared/components/icon.tsx";
import { CodingOpenContext } from "../../../shared/logic/coding_context.ts";

export function FileReferenceTags({
  references,
  onRemove,
}: {
  references: FileReference[];
  onRemove?: (index: number) => void;
}) {
  const coding = useContext(CodingOpenContext);
  return (
    <div className="file-reference-tags">
      {references.map((reference, index) => {
        const label = `${reference.path}${reference.startLine ? `:${reference.startLine}${reference.endLine && reference.endLine !== reference.startLine ? `-${reference.endLine}` : ""}` : ""}`;
        return (
          <span className="file-reference-tag" key={label}>
            <button
              type="button"
              aria-label={label}
              title={label}
              onClick={() => coding?.openFile(reference)}
            >
              <Icon name="file" size={13} />
              {reference.path.split("/").pop()}
              {reference.startLine
                ? `:${reference.startLine}${reference.endLine && reference.endLine !== reference.startLine ? `-${reference.endLine}` : ""}`
                : ""}
            </button>
            {onRemove && (
              <button
                type="button"
                aria-label={`移除引用 ${label}`}
                onClick={() => onRemove(index)}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
