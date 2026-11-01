import { useRef, useState } from "react";
import {
  loadSceneReferences,
  type SceneReferenceDraft,
  saveSceneReferences,
  verifySceneReference,
} from "./sceneReferenceDrafts.ts";

function withoutKey(record: Record<string, SceneReferenceDraft>, id: string) {
  const next = { ...record };
  delete next[id];
  return next;
}

// 每个对话保留自己的场景引用；同步 ref 避免连续更新读取过期状态。
export function useSceneReferences() {
  const [initial] = useState(() => {
    try {
      return { items: loadSceneReferences(window.localStorage), available: true };
    } catch {
      return { items: {}, available: false };
    }
  });
  const [references, updateReferences] = useState<Record<string, SceneReferenceDraft>>(
    initial.items,
  );
  const [storageAvailable, setStorageAvailable] = useState(initial.available);
  const referencesRef = useRef(references);

  function update(
    change: (items: Record<string, SceneReferenceDraft>) => Record<string, SceneReferenceDraft>,
  ) {
    const previous = referencesRef.current;
    const next = change(previous);
    if (next === previous) return;
    referencesRef.current = next;
    try {
      saveSceneReferences(window.localStorage, next);
      setStorageAvailable(true);
    } catch {
      setStorageAvailable(false);
    }
    updateReferences(next);
  }

  function set(id: string, reference: SceneReferenceDraft | null) {
    update((items) => (reference ? { ...items, [id]: reference } : withoutKey(items, id)));
  }

  function markStale(id: string) {
    update((items) => {
      const reference = items[id];
      return reference && !reference.stale
        ? { ...items, [id]: { ...reference, stale: true, checking: false } }
        : items;
    });
  }

  function verify(id: string, importId: string, revision: number) {
    update((items) => verifySceneReference(items, id, importId, revision));
  }

  function removeIfSame(id: string, reference: SceneReferenceDraft) {
    // 发送期间用户可能已选择新对象，只移除本次发送使用的引用。
    update((items) => (items[id] === reference ? withoutKey(items, id) : items));
  }

  return { references, storageAvailable, set, markStale, verify, removeIfSame };
}
