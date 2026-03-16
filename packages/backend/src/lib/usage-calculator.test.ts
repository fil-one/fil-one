import { describe, it, expect } from 'vitest';
import { calculateAverageUsage } from './usage-calculator.js';
import { TB_BYTES } from '@filone/shared';

describe('calculateAverageUsage', () => {
  it('returns zeros for empty samples', () => {
    const result = calculateAverageUsage([]);
    expect(result).toEqual({ averageStorageBytesUsed: 0, sampleCount: 0 });
  });

  it('handles a single sample', () => {
    const result = calculateAverageUsage([{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 5000 }]);
    expect(result.averageStorageBytesUsed).toBe(5000);
    expect(result.sampleCount).toBe(1);
  });

  it('calculates average of multiple samples', () => {
    const samples = [
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1000 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 3000 },
    ];
    const result = calculateAverageUsage(samples);
    expect(result.averageStorageBytesUsed).toBe(2000);
    expect(result.sampleCount).toBe(2);
  });

  it('returns TB_BYTES for TB_BYTES input (1 TB)', () => {
    const result = calculateAverageUsage([
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: TB_BYTES },
    ]);
    expect(result.averageStorageBytesUsed).toBe(TB_BYTES);
  });

  it('handles large values', () => {
    const tenTib = TB_BYTES * 10;
    const result = calculateAverageUsage([
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: tenTib },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: tenTib },
    ]);
    expect(result.averageStorageBytesUsed).toBe(tenTib);
  });

  it('handles mixed zero and non-zero values', () => {
    const samples = [
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 0 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: TB_BYTES },
    ];
    const result = calculateAverageUsage(samples);
    // BigInt division truncates, so TB_BYTES / 2 using BigInt
    expect(result.averageStorageBytesUsed).toBe(Math.trunc(TB_BYTES / 2));
  });
});
