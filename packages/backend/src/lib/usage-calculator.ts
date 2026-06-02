import { StorageUsageSample } from './service-orchestrator';

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
  return [...samples].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
}

/**
 * Merges multiple per-region storage time series into a single org-level series.
 *
 * Storage is a level (gauge), so for any timestamp where a region has no sample
 * we carry forward that region's last-known value (0 before its first sample).
 * This makes `calculateAverageUsage()` on the result a true org-wide average even
 * when regions return differing sample counts or timestamps — summing per-region
 * averages instead skews billing whenever series are misaligned (partial series,
 * API lag, a newly-provisioned tenant).
 *
 * Assumes each input series is already sorted ascending by timestamp, matching
 * how the orchestrator returns metrics (the worker relies on `.at(-1)` being the
 * latest sample). RFC3339 UTC `Z` timestamps sort correctly lexically.
 */
export function mergeStorageSamples(series: StorageUsageSample[][]): StorageUsageSample[] {
  const timestamps = [...new Set(series.flatMap((s) => s.map((p) => p.timestamp)))].sort();
  if (timestamps.length === 0) return [];

  const idx = series.map(() => 0);
  const lastBytes = series.map(() => 0);
  const lastCount = series.map(() => 0);

  return timestamps.map((timestamp) => {
    series.forEach((s, r) => {
      // Advance this region's pointer through every sample at or before the
      // current timestamp, carrying forward its most recent value.
      while (idx[r] < s.length && s[idx[r]].timestamp <= timestamp) {
        lastBytes[r] = s[idx[r]].bytesUsed ?? 0;
        lastCount[r] = s[idx[r]].objectCount ?? 0;
        idx[r] += 1;
      }
    });
    return {
      timestamp,
      bytesUsed: lastBytes.reduce((a, b) => a + b, 0),
      objectCount: lastCount.reduce((a, b) => a + b, 0),
    };
  });
}
