import { FILE_SNAPSHOT_MARKER, splitReferenceDraft } from "../../../../shared/file_references.ts";
import { FileReferenceTags } from "../../coding/components/file_reference_tags.tsx";

export function UserMessage({ text }: { text: string }) {
  const position = text.indexOf(FILE_SNAPSHOT_MARKER);
  if (position < 0) return <div className="message-text">{text}</div>;
  const draft = splitReferenceDraft(text.slice(0, position));
  return (
    <>
      {draft.text.trim() && <div className="message-text">{draft.text}</div>}
      <FileReferenceTags references={draft.references} />
      <details className="file-snapshots">
        <summary>已发送文件快照（{draft.references.length}）</summary>
        <pre>{text.slice(position + FILE_SNAPSHOT_MARKER.length)}</pre>
      </details>
    </>
  );
}
