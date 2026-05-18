import { describe, it, expect } from 'vitest';
import { UpdatePreferencesSchema } from './preferences.js';

describe('UpdatePreferencesSchema', () => {
  it('accepts marketingEmailsOptedIn: true', () => {
    const result = UpdatePreferencesSchema.safeParse({ marketingEmailsOptedIn: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marketingEmailsOptedIn).toBe(true);
    }
  });

  it('accepts marketingEmailsOptedIn: false', () => {
    const result = UpdatePreferencesSchema.safeParse({ marketingEmailsOptedIn: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marketingEmailsOptedIn).toBe(false);
    }
  });

  it('rejects non-boolean value', () => {
    const result = UpdatePreferencesSchema.safeParse({ marketingEmailsOptedIn: 'yes' });
    expect(result.success).toBe(false);
  });

  it('rejects missing field', () => {
    const result = UpdatePreferencesSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects null value', () => {
    const result = UpdatePreferencesSchema.safeParse({ marketingEmailsOptedIn: null });
    expect(result.success).toBe(false);
  });

  it('strips unknown fields', () => {
    const result = UpdatePreferencesSchema.safeParse({
      marketingEmailsOptedIn: true,
      extraField: 'ignored',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ marketingEmailsOptedIn: true });
    }
  });
});
