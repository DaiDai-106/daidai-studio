export type ComparisonIdentity = { importId: string; revision: number; model: object };
export type PlacementComparison = {
  importId: string;
  beforeRevision: number;
  afterRevision: number;
  before: string;
  after: string;
};

export function canComparePlacement(
  previous: ComparisonIdentity | null,
  next: ComparisonIdentity | null,
  enabled: boolean,
) {
  return !!(
    enabled &&
    previous &&
    next &&
    previous.importId === next.importId &&
    previous.model === next.model &&
    next.revision > previous.revision
  );
}

export function labelPlacementComparison(
  previous: ComparisonIdentity,
  next: ComparisonIdentity,
  images: { before: string; after: string },
): PlacementComparison {
  return {
    importId: next.importId,
    beforeRevision: previous.revision,
    afterRevision: next.revision,
    ...images,
  };
}

// 即使无法截图也要应用新状态；前后截图使用同一个固定的相机。
export function captureTransition<TCamera, TImage>(
  camera: TCamera,
  capture: (camera: TCamera) => TImage | null,
  apply: () => void,
): { before: TImage; after: TImage } | null {
  let before: TImage | null = null;
  try {
    before = capture(camera);
  } catch {
    // 图形上下文丢失不能阻止状态更新。
  }
  apply();
  if (before === null) return null;
  try {
    const after = capture(camera);
    return after === null ? null : { before, after };
  } catch {
    return null;
  }
}
