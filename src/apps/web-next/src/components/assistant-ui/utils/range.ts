/** Clamp caller-controlled counts before they reach array slicing or CSS. */
export function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Return the first `count` items, with an out-of-range count normalized. */
export function take<T>(items: readonly T[], count: number) {
  return items.slice(0, Math.floor(clamp(count, 0, items.length)));
}
