import { describe, it, expect } from 'vitest';
import { getStatusDisplay } from './instatus.js';

describe('getStatusDisplay', () => {
  const cases = [
    { status: 'UP', expected: { color: 'green', label: 'All systems operational' } },
    { status: 'HASISSUES', expected: { color: 'red', label: 'Service disruption' } },
    { status: 'UNDERMAINTENANCE', expected: { color: 'blue', label: 'Under maintenance' } },
  ] as const;

  for (const { status, expected } of cases) {
    it(`returns ${expected.color}/"${expected.label}" for status ${status}`, () => {
      expect(getStatusDisplay(status)).toEqual(expected);
    });
  }

  it('falls back to grey/"Status unavailable" for unknown status', () => {
    expect(getStatusDisplay('SOMETHING_NEW')).toEqual({
      color: 'grey',
      label: 'Status unavailable',
    });
  });
});
