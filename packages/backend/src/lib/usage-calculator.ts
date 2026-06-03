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
 * does not sort; FTH returns upstream order as-is). Callers that rely on order
 * — `.at(-1)` for the latest sample, and `mergeStorageSamples`'s carry-forward
 * — must sort first. RFC3339 UTC `Z` timestamps sort correctly lexically.
 */
export function sortStorageSamplesByTimestamp(samples: StorageUsageSample[]): StorageUsageSample[] {
  return [...samples].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}
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
  const timestamps = [...new Set(series.flatMap((s) => s.map((p) => p.timestamp)))].sort();

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
 * forward into gaps (0 before its first sample). Assumes both are sorted
 * ascending by timestamp.
 */
function fillGaps(samples: StorageUsageSample[], timestamps: string[]): StorageUsageSample[] {
  return timestamps.map((timestamp) => {
    const latest = samples.filter((s) => s.timestamp <= timestamp).at(-1);
    return {
      timestamp,
      bytesUsed: latest?.bytesUsed ?? 0,
      objectCount: latest?.objectCount ?? 0,
    };
  });
}
