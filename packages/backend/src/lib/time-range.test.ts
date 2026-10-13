import { describe, expect, it } from 'vitest';
import { dedupeByTimestamp, splitTimeRange } from './time-range.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('splitTimeRange', () => {
  it('returns the range unchanged when it fits within the max', () => {
    expect(
      splitTimeRange('2026-01-01T00:00:00.000Z', '2026-01-11T00:00:00.000Z', 10 * DAY_MS),
    ).toEqual([{ from: '2026-01-01T00:00:00.000Z', to: '2026-01-11T00:00:00.000Z' }]);
  });

  it('splits a longer range into contiguous chunks ending at to', () => {
    expect(
      splitTimeRange('2026-01-01T00:00:00.000Z', '2026-01-25T00:00:00.000Z', 10 * DAY_MS),
    ).toEqual([
      { from: '2026-01-01T00:00:00.000Z', to: '2026-01-11T00:00:00.000Z' },
      { from: '2026-01-11T00:00:00.000Z', to: '2026-01-21T00:00:00.000Z' },
      { from: '2026-01-21T00:00:00.000Z', to: '2026-01-25T00:00:00.000Z' },
    ]);
  });
});

describe('dedupeByTimestamp', () => {
  it('keeps the first sample per timestamp and every sample without one', () => {
    expect(
      dedupeByTimestamp([
        { timestamp: 'a', v: 1 },
        { timestamp: 'b', v: 2 },
        { timestamp: 'a', v: 3 },
        { v: 4 },
      ]),
    ).toEqual([{ timestamp: 'a', v: 1 }, { timestamp: 'b', v: 2 }, { v: 4 }]);
  });
});
