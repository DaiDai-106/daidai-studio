import type { ConversationInfo, ProjectInfo } from "../../../contracts/application.ts";

// 合并新快照和分页历史，并过滤已移除的项目。
export function mergeConversations(
  previous: readonly ConversationInfo[],
  incoming: readonly ConversationInfo[],
  projects: readonly ProjectInfo[],
) {
  const visible = new Set(projects.map((project) => project.id));
  const records = new Map(
    [...previous, ...incoming]
      .filter((item) => visible.has(item.projectId))
      .map((item) => [item.id, item]),
  );
  return [...records.values()].sort(
    (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  );
}
