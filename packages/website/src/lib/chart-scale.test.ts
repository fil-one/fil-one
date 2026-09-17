import { describe, it, expect } from 'vitest';

import { niceScale } from './chart-scale';

describe('niceScale', () => {
  it('starts at zero and covers the maximum without clipping', () => {
    const { domainMax, ticks } = niceScale(27_000_000);
    expect(ticks[0]).toBe(0);
    expect(domainMax).toBeGreaterThanOrEqual(27_000_000);
    expect(ticks[ticks.length - 1]).toBe(domainMax);
  });

  it('spaces ticks evenly', () => {
    const steps = (ticks: number[]) => new Set(ticks.slice(1).map((t, i) => t - ticks[i]));
    expect(steps(niceScale(27_000_000).ticks).size).toBe(1);
    expect(steps(niceScale(22, { integer: true, tickCount: 6 }).ticks).size).toBe(1);
  });

  it('replaces the storage axis that shipped with round gridlines', () => {
    // What the dashboard drew for a 27 MB week: 18 · 20 · 23 · 25 · 27.
    expect(niceScale(27_000_000, { tickCount: 5 })).toEqual({
      domainMax: 30_000_000,
      ticks: [0, 10_000_000, 20_000_000, 30_000_000],
    });
  });

  it('replaces the objects axis that shipped, baseline included', () => {
    // What the dashboard drew for a 22-object week: 7 · 10 · 13 · 16 · 19 · 22,
    // with the 7 baseline hiding four days of data.
    expect(niceScale(22, { integer: true, tickCount: 6 })).toEqual({
      domainMax: 25,
      ticks: [0, 5, 10, 15, 20, 25],
    });
  });

  it('does not strand the series at the bottom of an oversized axis', () => {
    // A nice step alone would round 27M up to a 40M domain and leave a third of
    // the plot empty; the domain is tightened to the first step above the data.
    const { domainMax } = niceScale(27_000_000, { tickCount: 5 });
    expect(domainMax / 27_000_000).toBeLessThan(1.5);
  });

  it('keeps counts whole', () => {
    const { ticks } = niceScale(22, { integer: true, tickCount: 6 });
    expect(ticks.every(Number.isInteger)).toBe(true);
  });

  it('does not collapse to a fractional step for tiny counts', () => {
    // max 2 over 5 intervals wants a step of 0.4; a count axis cannot have one.
    expect(niceScale(2, { integer: true, tickCount: 6 }).ticks).toEqual([0, 1, 2]);
  });

  it('gives an all-zero window a single zero tick rather than a made-up scale', () => {
    expect(niceScale(0)).toEqual({ domainMax: 1, ticks: [0] });
  });

  it('treats a missing or negative maximum as empty', () => {
    expect(niceScale(Number.NaN).ticks).toEqual([0]);
    expect(niceScale(-5).ticks).toEqual([0]);
  });

  it('produces exact tick values, free of floating-point drift', () => {
    // 0.1 * 3 is 0.30000000000000004, and a tick label is where that shows.
    expect(niceScale(0.5, { tickCount: 6 }).ticks).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  });
});
