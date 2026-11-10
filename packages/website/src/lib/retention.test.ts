import { describe, expect, it } from 'vitest';

import { describeRetention } from './retention.js';

describe('describeRetention', () => {
  it.each([
    {
      unit: 'days',
      mode: 'compliance',
      duration: 15,
      type: 'd',
      expected: '15-day compliance retention',
    },
    {
      unit: 'years',
      mode: 'governance',
      duration: 2,
      type: 'y',
      expected: '2-year governance retention',
    },
  ] as const)('phrases a policy counted in $unit', ({ mode, duration, type, expected }) => {
    expect(describeRetention(mode, duration, type)).toBe(expected);
  });

  it('returns null for a policy with no duration', () => {
    expect(describeRetention('compliance', undefined, 'd')).toBeNull();
  });
});
