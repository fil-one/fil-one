import { describe, it, expect } from 'vitest';
import { isUuid } from './uuid.ts';

describe('isUuid', () => {
  it('accepts an id the platform mints', () => {
    expect(isUuid(crypto.randomUUID())).toBe(true);
  });

  it('accepts upper case', () => {
    expect(isUuid('11111111-2222-3333-4444-555555555555'.toUpperCase())).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['no hyphens', '111111112222333344445555555555555'],
    ['too short a group', '11111111-2222-3333-4444-55555555555'],
    ['a non-hex character', '1111111g-2222-3333-4444-555555555555'],
    ['trailing text', '11111111-2222-3333-4444-555555555555x'],
    ['leading whitespace', ' 11111111-2222-3333-4444-555555555555'],
    // The one that matters: `#` is the key separator every row shape is built
    // from, so a value carrying one must never reach a key expression.
    ['a key separator', 'ORG#11111111-2222-3333-4444-555555555555'],
    ['a DynamoDB expression fragment', '11111111-2222-3333-4444-555555555555#MEMBER'],
  ])('rejects %s', (_label, value) => {
    expect(isUuid(value)).toBe(false);
  });
});
