/** 使用实际工作区边界计算右侧面板比例，避免窗口和侧栏尺寸影响拖动结果。 */
export function rightPanePercent(
  clientX: number,
  bounds: { left: number; right: number },
  min: number,
  max: number,
): number {
  const width = bounds.right - bounds.left;
  if (width <= 0) return min;
  return Math.max(min, Math.min(max, ((bounds.right - clientX) / width) * 100));
}
