export type SceneNode = { id: string; parentId: string | null; deleted?: boolean };

/** 删除只改变场景元数据，保留源文件、显示资源与其他实例。 */
export function markDeletedSubtree<T extends SceneNode>(
  objects: readonly T[],
  objectId: string,
): (T & { deleted?: boolean })[] {
  const byId = new Map<string, T>();
  const children = new Map<string, string[]>();
  for (const object of objects) {
    if (byId.has(object.id)) throw new Error("场景对象 ID 重复。");
    byId.set(object.id, object);
  }

  const target = byId.get(objectId);
  if (!target) throw new Error("场景对象不存在。");
  if (target.deleted) throw new Error("场景对象已删除。");

  for (const object of objects) {
    if (object.parentId !== null) {
      if (!byId.has(object.parentId)) throw new Error("场景父对象不存在。");
      const siblings = children.get(object.parentId) ?? [];
      siblings.push(object.id);
      children.set(object.parentId, siblings);
    }
  }

  // 用迭代遍历检测完整层级，避免恶意深层对象造成递归栈溢出。
  const complete = new Set<string>();
  for (const object of objects) {
    const path: string[] = [];
    const visiting = new Set<string>();
    let current: SceneNode | undefined = object;
    while (current && !complete.has(current.id)) {
      if (visiting.has(current.id)) throw new Error("场景对象层级循环。");
      visiting.add(current.id);
      path.push(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    for (const id of path) complete.add(id);
  }

  let ancestor: SceneNode | undefined = target;
  while (ancestor?.parentId !== null && ancestor?.parentId !== undefined) {
    ancestor = byId.get(ancestor.parentId);
    if (ancestor?.deleted) throw new Error("场景对象的父对象已删除。");
  }

  const deleted = new Set<string>();
  const pending = [objectId];
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined) break;
    deleted.add(id);
    for (const child of children.get(id) ?? []) pending.push(child);
  }

  return objects.map((object) => (deleted.has(object.id) ? { ...object, deleted: true } : object));
}
