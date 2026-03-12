import type { ModelStorageMetricsSample } from '@filone/aurora-backoffice-client';

export interface UsageCalculationResult {
  averageStorageBytesUsed: number;
  sampleCount: number;
}

export function calculateAverageUsage(
  samples: ModelStorageMetricsSample[],
): UsageCalculationResult {
  if (samples.length === 0) {
    return { averageStorageBytesUsed: 0, sampleCount: 0 };
  }

  const totalBytes = samples.reduce((sum, s) => sum + BigInt(s.bytesUsed ?? 0), 0n);
  const averageStorageBytesUsed = Number(totalBytes / BigInt(samples.length));

  return { averageStorageBytesUsed, sampleCount: samples.length };
}
