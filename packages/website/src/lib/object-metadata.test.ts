import { describe, it, expect } from 'vitest';

import { isRetentionActive } from './object-metadata.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');

describe('isRetentionActive', () => {
  it.each([
    ['holds the object until a date still to come', '2026-11-12T00:00:00Z', true],
    ['no longer holds it once the date has passed', '2026-05-02T00:00:00Z', false],
  ])('%s', (_case, retainUntilDate, active) => {
    expect(isRetentionActive({ mode: 'COMPLIANCE', retainUntilDate }, NOW)).toBe(active);
  });
});
