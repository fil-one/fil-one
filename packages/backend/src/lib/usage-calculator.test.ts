import { describe, it, expect } from 'vitest';
import {
  calculateAverageUsage,
  mergeStorageSamples,
  sortStorageSamplesByTimestamp,
} from './usage-calculator.js';
import { TB_BYTES } from '@filone/shared';

describe('calculateAverageUsage', () => {
  it('returns zeros for empty samples', () => {
    const result = calculateAverageUsage([]);
    expect(result).toEqual({ averageStorageBytesUsed: 0, sampleCount: 0 });
  });

  it('handles a single sample', () => {
    const result = calculateAverageUsage([
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 5000, objectCount: 0 },
    ]);
    expect(result.averageStorageBytesUsed).toBe(5000);
    expect(result.sampleCount).toBe(1);
  });

  it('calculates average of multiple samples', () => {
    const samples = [
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1000, objectCount: 0 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 3000, objectCount: 0 },
    ];
    const result = calculateAverageUsage(samples);
    expect(result.averageStorageBytesUsed).toBe(2000);
    expect(result.sampleCount).toBe(2);
  });

  it('returns TB_BYTES for TB_BYTES input (1 TB)', () => {
    const result = calculateAverageUsage([
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: TB_BYTES, objectCount: 0 },
    ]);
    expect(result.averageStorageBytesUsed).toBe(TB_BYTES);
  });

  it('handles large values', () => {
    const tenTib = TB_BYTES * 10;
    const result = calculateAverageUsage([
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: tenTib, objectCount: 0 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: tenTib, objectCount: 0 },
    ]);
    expect(result.averageStorageBytesUsed).toBe(tenTib);
  });

  it('handles mixed zero and non-zero values', () => {
    const samples = [
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 0, objectCount: 0 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: TB_BYTES, objectCount: 0 },
    ];
    const result = calculateAverageUsage(samples);
    // BigInt division truncates, so TB_BYTES / 2 using BigInt
    expect(result.averageStorageBytesUsed).toBe(Math.trunc(TB_BYTES / 2));
  });
});

describe('mergeStorageSamples', () => {
  it('returns an empty series for no input', () => {
    expect(mergeStorageSamples([])).toEqual([]);
    expect(mergeStorageSamples([[], []])).toEqual([]);
  });

  it('passes a single series through unchanged (bytes + objectCount)', () => {
    const series = [
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1000, objectCount: 2 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 3000, objectCount: 5 },
    ];
    expect(mergeStorageSamples([series])).toEqual(series);
  });

  it('sums two aligned series per timestamp', () => {
    const a = [
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1000, objectCount: 1 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 2000, objectCount: 2 },
    ];
    const b = [
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 500, objectCount: 3 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 700, objectCount: 4 },
    ];
    expect(mergeStorageSamples([a, b])).toEqual([
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1500, objectCount: 4 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 2700, objectCount: 6 },
    ]);
  });

  it('carries forward the last value when a region has a leading gap', () => {
    // Region A is steady at 2000; region B is provisioned at t1 only.
    const a = [
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 2000, objectCount: 0 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 2000, objectCount: 0 },
    ];
    const b = [{ timestamp: '2024-01-01T01:00:00Z', bytesUsed: 4000, objectCount: 0 }];

    const merged = mergeStorageSamples([a, b]);
    expect(merged).toEqual([
      // B contributes 0 before its first sample.
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 2000, objectCount: 0 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 6000, objectCount: 0 },
    ]);

    // The org-level average is the carry-forward merge (4000), not the
    // sum of per-region means (2000 + 4000 = 6000).
    expect(calculateAverageUsage(merged).averageStorageBytesUsed).toBe(4000);
  });

  it('carries forward a prior value across a mid-series gap', () => {
    const a = [
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1000, objectCount: 0 },
      { timestamp: '2024-01-01T02:00:00Z', bytesUsed: 3000, objectCount: 0 },
    ];
    // B only reports at the middle timestamp.
    const b = [{ timestamp: '2024-01-01T01:00:00Z', bytesUsed: 8000, objectCount: 0 }];

    expect(mergeStorageSamples([a, b])).toEqual([
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1000, objectCount: 0 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 9000, objectCount: 0 }, // A carried fwd
      { timestamp: '2024-01-01T02:00:00Z', bytesUsed: 11000, objectCount: 0 }, // B carried fwd
    ]);
  });
});

describe('sortStorageSamplesByTimestamp', () => {
  it('returns an empty array unchanged', () => {
    expect(sortStorageSamplesByTimestamp([])).toEqual([]);
  });

  it('leaves an already-sorted series in order', () => {
    const samples = [
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1000, objectCount: 1 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 2000, objectCount: 2 },
    ];
    expect(sortStorageSamplesByTimestamp(samples)).toEqual(samples);
  });

  it('orders out-of-order samples ascending so .at(-1) is the latest', () => {
    const samples = [
      { timestamp: '2024-01-01T02:00:00Z', bytesUsed: 3000, objectCount: 0 },
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1000, objectCount: 0 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 2000, objectCount: 0 },
    ];
    const sorted = sortStorageSamplesByTimestamp(samples);
    expect(sorted.map((s) => s.timestamp)).toEqual([
      '2024-01-01T00:00:00Z',
      '2024-01-01T01:00:00Z',
      '2024-01-01T02:00:00Z',
    ]);
    expect(sorted.at(-1)?.bytesUsed).toBe(3000);
  });

  it('does not mutate the input array', () => {
    const samples = [
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 2000, objectCount: 0 },
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1000, objectCount: 0 },
    ];
    const before = [...samples];
    sortStorageSamplesByTimestamp(samples);
    expect(samples).toEqual(before);
  });
});
