import { describe, it, expect } from 'vitest';
import { isIdentityTombstoned } from './identity-tombstone.js';

describe('isIdentityTombstoned', () => {
  it('is true only for an explicit BOOL true', () => {
    expect(isIdentityTombstoned({ deleted: { BOOL: true } })).toBe(true);
    expect(isIdentityTombstoned({ deleted: { BOOL: false } })).toBe(false);
  });

  it('is false for a live identity row', () => {
    expect(isIdentityTombstoned({ userId: { S: 'u1' }, orgId: { S: 'o1' } })).toBe(false);
  });

  it('is false when the row is absent — a sub that never signed up is not deleted', () => {
    expect(isIdentityTombstoned(undefined)).toBe(false);
  });
});
