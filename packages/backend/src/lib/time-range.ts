/** Splits [from, to] into contiguous sub-ranges no longer than maxRangeMs. */
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
  let cursor = fromMs;
  while (cursor < toMs) {
    const next = Math.min(cursor + maxRangeMs, toMs);
    ranges.push({
      from: new Date(cursor).toISOString(),
      to: new Date(next).toISOString(),
    });
    cursor = next;
  }
  return ranges;
}

export function dedupeByTimestamp<T extends { timestamp?: string }>(samples: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const sample of samples) {
    const key = sample.timestamp;
    if (key === undefined) {
      out.push(sample);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sample);
  }
  return out;
}
