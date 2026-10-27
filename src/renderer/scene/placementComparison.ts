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

// Always apply the new state, even when capture is unavailable. Both images use one frozen camera.
export function captureTransition<TCamera, TImage>(
  camera: TCamera,
  capture: (camera: TCamera) => TImage | null,
  apply: () => void,
): { before: TImage; after: TImage } | null {
  let before: TImage | null = null;
  try {
    before = capture(camera);
  } catch {
    /* A lost graphics context must not block updates. */
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
