import { describe, it, expect } from 'vitest';
import { OrgNameSchema, ORG_NAME_MIN_LENGTH, ORG_NAME_MAX_LENGTH } from './org.js';

describe('OrgNameSchema', () => {
  describe('valid names', () => {
    it.each([
      'Acme Corp',
      'A.B.',
      'My-Org 123',
      'ab',
      'A'.repeat(ORG_NAME_MAX_LENGTH),
      'Fil.one Storage',
      'Test 1.0',
    ])('accepts "%s"', (name) => {
      expect(() => OrgNameSchema.parse(name)).not.toThrow();
    });
  });

  describe('invalid — disallowed characters', () => {
    it.each([
      ['@ symbol', 'Acme@Corp'],
      ['exclamation mark', 'Test!'],
      ['HTML tags', '<script>'],
      ['underscore', 'Org_Name'],
      ['hash', 'Hello#World'],
      ['ampersand', 'Acme & Co'],
      ['plus sign', 'Org+Name'],
      ['single quotes', "Acme's"],
    ])('rejects name with %s', (_label, name) => {
      const result = OrgNameSchema.safeParse(name);
      expect(result.success).toBe(false);
    });
  });

  describe('invalid — length', () => {
    it('rejects empty string', () => {
      const result = OrgNameSchema.safeParse('');
      expect(result.success).toBe(false);
    });

    it('rejects single character', () => {
      const result = OrgNameSchema.safeParse('A');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          `at least ${ORG_NAME_MIN_LENGTH} characters`,
        );
      }
    });

    it('rejects string exceeding max length', () => {
      const result = OrgNameSchema.safeParse('A'.repeat(ORG_NAME_MAX_LENGTH + 1));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          `at most ${ORG_NAME_MAX_LENGTH} characters`,
        );
      }
    });
  });

  it('trims whitespace before validation', () => {
    const result = OrgNameSchema.parse('  Acme Corp  ');
    expect(result).toBe('Acme Corp');
  });

  it('trims whitespace when string exceeds max length', () => {
    const result = OrgNameSchema.parse('  Acme Corp' + ' '.repeat(ORG_NAME_MAX_LENGTH));
    expect(result).toBe('Acme Corp');
  });

  it('reports allowed-characters error message', () => {
    const result = OrgNameSchema.safeParse('Acme@Corp');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain(
        'letters, numbers, spaces, hyphens, and periods',
      );
    }
  });
});
