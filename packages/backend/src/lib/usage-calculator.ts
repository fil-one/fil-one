import { TIB_BYTES } from '@hyperspace/shared';
import type { ModelStorageMetricsSample } from '@hyperspace/aurora-backoffice-client';

export interface UsageCalculationResult {
  averageBytesUsed: number;
  averageTib: number;
  sampleCount: number;
}

export function calculateAverageUsage(samples: ModelStorageMetricsSample[]): UsageCalculationResult {
  if (samples.length === 0) {
    return { averageBytesUsed: 0, averageTib: 0, sampleCount: 0 };
  }

  const totalBytes = samples.reduce((sum, s) => sum + (s.bytesUsed ?? 0), 0);
  const averageBytesUsed = totalBytes / samples.length;
  const averageTib = averageBytesUsed / TIB_BYTES;

  return { averageBytesUsed, averageTib, sampleCount: samples.length };
}
