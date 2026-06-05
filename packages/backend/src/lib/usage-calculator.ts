import type { StorageUsageSample } from './service-orchestrator.js';

export interface UsageCalculationResult {
  averageStorageBytesUsed: number;
  sampleCount: number;
}

export function calculateAverageUsage(samples: StorageUsageSample[]): UsageCalculationResult {
  if (samples.length === 0) {
    return { averageStorageBytesUsed: 0, sampleCount: 0 };
  }

  const totalBytes = samples.reduce((sum, s) => sum + BigInt(s.bytesUsed ?? 0), 0n);
  const averageStorageBytesUsed = Number(totalBytes / BigInt(samples.length));

  return { averageStorageBytesUsed, sampleCount: samples.length };
}

/**
 * Returns a copy of the series sorted ascending by timestamp.
 *
 * The orchestrators do not guarantee chronological order (Aurora flattens
 * parallel multi-range fetches through `dedupeByTimestamp`, which dedupes but
 * does not sort; FTH returns upstream order as-is), so callers that rely on order
 * — `.at(-1)` for the latest sample, and `mergeStorageSamples`'s carry-forward —
 * must sort first. Sample timestamps are canonical ISO-8601 UTC (emitted by the
 * orchestrator via `new Date(...).toISOString()`), a fixed-width form whose lexical
 * order matches chronological order, so a plain string compare suffices.
 */
export function sortStorageSamplesByTimestamp(samples: StorageUsageSample[]): StorageUsageSample[] {
  return [...samples].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
}

/**
 * Merges per-region storage series into one org-level series, summing each
 * region's last-known value at every timestamp. Storage is a gauge, so a region
 * with no sample at a timestamp carries forward its previous value (0 before its
 * first). This keeps a later `calculateAverageUsage()` accurate when regions
 * report misaligned timestamps; summing per-region averages would skew billing.
 *
 * Assumes each series is sorted ascending by timestamp (e.g. via
 * `sortStorageSamplesByTimestamp`) — carry-forward depends on order.
 */
export function mergeStorageSamples(series: StorageUsageSample[][]): StorageUsageSample[] {
  // Build the shared grid: the sorted union of all distinct timestamps. Timestamps
  // are canonical ISO-8601 UTC, so the same instant is always the same string
  // (dedupe via Set, each region then carries forward across it once) and lexical
  // order matches chronological order.
  const timestamps = [
    ...new Set(series.flatMap((samples) => samples.map((p) => p.timestamp))),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Align every region onto the shared timestamp grid, then sum the aligned
  // grids element-wise — once gaps are filled, the merge is a plain sum.
  const aligned = series.map((samples) => fillGaps(samples, timestamps));
  return timestamps.map((timestamp, i) => ({
    timestamp,
    bytesUsed: aligned.reduce((sum, s) => sum + s[i].bytesUsed, 0),
    objectCount: aligned.reduce((sum, s) => sum + s[i].objectCount, 0),
  }));
}

/**
 * Resamples one region's series onto `timestamps`, carrying its last-known value
 * forward into gaps (0 before its first sample). Assumes both are sorted ascending,
 * so a single pointer walks `samples` once as `timestamps` advances. Timestamps are
 * canonical ISO-8601 UTC, so the `<=` advance is a plain string compare.
 */
function fillGaps(samples: StorageUsageSample[], timestamps: string[]): StorageUsageSample[] {
  let i = 0;
  let latest: StorageUsageSample | undefined;
  return timestamps.map((timestamp) => {
    while (i < samples.length && samples[i].timestamp <= timestamp) {
      latest = samples[i];
      i += 1;
    }
    return {
      timestamp,
      bytesUsed: latest?.bytesUsed ?? 0,
      objectCount: latest?.objectCount ?? 0,
    };
  });
}
