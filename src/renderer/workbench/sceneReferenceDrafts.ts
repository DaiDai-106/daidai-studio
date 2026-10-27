import type { SceneReference } from "../../shared/application.ts";

export type SceneReferenceDraft = SceneReference & {
  name: string;
  stale?: boolean;
  checking?: boolean;
};
const key = "dai.sceneReferenceDrafts.v1";

export function loadSceneReferences(
  storage: Pick<Storage, "getItem">,
): Record<string, SceneReferenceDraft> {
  const raw = storage.getItem(key);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const result: Record<string, SceneReferenceDraft> = {};
  for (const [id, value] of Object.entries(parsed).slice(0, 1000)) {
    if (!/^[0-9]+$/.test(id) || !value || typeof value !== "object" || Array.isArray(value))
      continue;
    const { importId, objectId, revision, name, stale } = value as Record<string, unknown>;
    if (
      typeof importId !== "string" ||
      !/^[0-9a-f]{64}$/.test(importId) ||
      typeof objectId !== "string" ||
      !objectId.length ||
      objectId.length > 200 ||
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof name !== "string" ||
      name.length > 1000 ||
      (stale !== undefined && typeof stale !== "boolean")
    )
      continue;
    result[id] = {
      importId,
      objectId,
      revision,
      name,
      ...(stale ? { stale: true } : { checking: true }),
    };
  }
  return result;
}

export function saveSceneReferences(
  storage: Pick<Storage, "setItem">,
  items: Record<string, SceneReferenceDraft>,
) {
  storage.setItem(key, JSON.stringify(items));
}

export function verifySceneReference(
  items: Record<string, SceneReferenceDraft>,
  id: string,
  importId: string,
  revision: number,
) {
  const reference = items[id];
  if (!reference || reference.stale) return items;
  const matches = reference.importId === importId && reference.revision === revision;
  if (matches && !reference.checking) return items;
  return { ...items, [id]: { ...reference, stale: !matches, checking: false } };
}
