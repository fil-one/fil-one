const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Splits [from, to] into contiguous sub-ranges no longer than maxRangeMs. Every
 * boundary after `from` falls on UTC midnight, so the later of two adjacent
 * chunks covers the boundary day whole.
 */
export function splitTimeRange(
  fromIso: string,
  toIso: string,
  maxRangeMs: number,
): Array<{ from: string; to: string }> {
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return [{ from: fromIso, to: toIso }];
  }
  if (toMs - fromMs <= maxRangeMs) {
    return [{ from: fromIso, to: toIso }];
  }
  const ranges: Array<{ from: string; to: string }> = [];
  let start = fromIso;
  let cursor = fromMs - (fromMs % DAY_MS);
  while (cursor + maxRangeMs < toMs) {
    cursor += maxRangeMs;
    const next = new Date(cursor).toISOString();
    ranges.push({ from: start, to: next });
    start = next;
  }
  ranges.push({ from: start, to: toIso });
  return ranges;
}

/**
 * Keeps the last sample for each timestamp. Chunks are concatenated in order,
 * so on a boundary day the later chunk's whole-day reading wins.
 */
export function dedupeByTimestamp<T extends { timestamp?: string }>(samples: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    const key = samples[i].timestamp;
    if (key !== undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(samples[i]);
  }
  return out.reverse();
}
