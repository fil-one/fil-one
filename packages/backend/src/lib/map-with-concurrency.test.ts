import { describe, it, expect } from 'vitest';

import { mapWithConcurrency } from './map-with-concurrency.js';

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const result = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it('never runs more than `limit` at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
      },
    );
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('handles an empty list without spawning workers', async () => {
    expect(await mapWithConcurrency([], 4, async () => 'x')).toEqual([]);
  });

  it('passes the index to the mapper', async () => {
    const result = await mapWithConcurrency(
      ['a', 'b'],
      1,
      async (item, index) => `${index}${item}`,
    );
    expect(result).toEqual(['0a', '1b']);
  });

  it('rejects a limit below one', async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toBeInstanceOf(RangeError);
  });

  it('propagates a mapper rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
