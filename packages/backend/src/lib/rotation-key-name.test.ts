import { describe, it, expect } from 'vitest';
import { KEY_NAME_MAX_LENGTH, KEY_NAME_PATTERN } from '@filone/shared';
import { vendorNameForRotation } from './rotation-key-name.ts';

describe('vendorNameForRotation', () => {
  it('keeps the name and adds a suffix', () => {
    expect(vendorNameForRotation('My Key')).toMatch(/^My Key\.r[0-9a-f]{6}$/);
  });

  it('gives every attempt a different name', () => {
    const names = new Set(Array.from({ length: 50 }, () => vendorNameForRotation('My Key')));
    expect(names.size).toBe(50);
  });

  it('fits a name the vendor will accept, however long the original', () => {
    const name = vendorNameForRotation('a'.repeat(KEY_NAME_MAX_LENGTH));
    expect(name.length).toBeLessThanOrEqual(KEY_NAME_MAX_LENGTH);
    expect(name).toMatch(KEY_NAME_PATTERN);
  });

  it('does not stack suffixes when a rotated name is rotated again', () => {
    const once = vendorNameForRotation('b'.repeat(KEY_NAME_MAX_LENGTH));
    const twice = vendorNameForRotation(once);
    expect(twice.length).toBeLessThanOrEqual(KEY_NAME_MAX_LENGTH);
  });

  it('leaves no trailing space where the trim landed', () => {
    const name = vendorNameForRotation(`${'c'.repeat(KEY_NAME_MAX_LENGTH - 9)} tail`);
    expect(name).not.toContain(' .r');
    expect(name).toMatch(KEY_NAME_PATTERN);
  });
});
