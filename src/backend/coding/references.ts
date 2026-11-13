import { FILE_SNAPSHOT_MARKER, fileReferences } from "../../shared/file_references.ts";
import type { createCodingFileService } from "./file_service.ts";

/** 引用在发送时读取，聊天历史与模型接收同一份带哈希、行号的快照。 */
export async function resolveFileReferences(
  files: ReturnType<typeof createCodingFileService>,
  projectId: string,
  text: string,
) {
  const references = fileReferences(text);
  if (references.length > 5) throw new Error("一次最多引用 5 个文件。");
  let total = 0;
  const snapshots: string[] = [];
  for (const reference of references) {
    const file = await files.read(projectId, reference.path);
    const lines = file.content.split("\n");
    if (file.content.endsWith("\n")) lines.pop();
    const start = reference.startLine ?? 1;
    const end = reference.endLine ?? Math.max(1, lines.length);
    if (start > Math.max(1, lines.length) || end > Math.max(1, lines.length))
      throw new Error(`引用行范围超出文件：${reference.path}`);
    const content = lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}: ${line}`)
      .join("\n");
    total += content.length;
    if (content.length > 32_000 || total > 64_000)
      throw new Error("文件引用过大，请减少引用或选择较小的文件。");
    snapshots.push(
      JSON.stringify({
        path: reference.path,
        startLine: start,
        endLine: end,
        sha256: file.version,
        content,
      }),
    );
  }
  return snapshots.length ? `${text}${FILE_SNAPSHOT_MARKER}${snapshots.join("\n")}` : text;
}
