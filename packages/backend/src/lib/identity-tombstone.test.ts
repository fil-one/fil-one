import { describe, it, expect } from 'vitest';
import { isIdentityTombstoned } from './identity-tombstone.js';

describe('isIdentityTombstoned', () => {
  it('reads the deletedAt stamp the scrub writes', () => {
    expect(isIdentityTombstoned({ deletedAt: { S: '2026-08-12T00:00:00.000Z' } })).toBe(true);
  });

  it('is false for a live identity row', () => {
    expect(isIdentityTombstoned({ userId: { S: 'u1' }, orgId: { S: 'o1' } })).toBe(false);
  });

  it('is false when the row is absent — a sub that never signed up is not deleted', () => {
    expect(isIdentityTombstoned(undefined)).toBe(false);
  });
});
