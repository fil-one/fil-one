import { describe, it, expect } from 'vitest';
import { UpdatePreferencesSchema } from './preferences.ts';

describe('UpdatePreferencesSchema', () => {
  it('accepts marketingEmailsOptedIn: true', () => {
    const result = UpdatePreferencesSchema.safeParse({ marketingEmailsOptedIn: true });
    expect(result).toStrictEqual({ success: true, data: { marketingEmailsOptedIn: true } });
  });

  it('accepts marketingEmailsOptedIn: false', () => {
    const result = UpdatePreferencesSchema.safeParse({ marketingEmailsOptedIn: false });
    expect(result).toStrictEqual({ success: true, data: { marketingEmailsOptedIn: false } });
  });

  it('rejects non-boolean value', () => {
    const result = UpdatePreferencesSchema.safeParse({ marketingEmailsOptedIn: 'yes' });
    expect(result).toMatchObject({
      success: false,
      error: {
        issues: [
          {
            code: 'invalid_type',
            path: ['marketingEmailsOptedIn'],
            message: 'Invalid input: expected boolean, received string',
          },
        ],
      },
    });
  });

  it('rejects missing field', () => {
    const result = UpdatePreferencesSchema.safeParse({});
    expect(result).toMatchObject({
      success: false,
      error: {
        issues: [
          {
            code: 'invalid_type',
            path: ['marketingEmailsOptedIn'],
            message: 'Invalid input: expected boolean, received undefined',
          },
        ],
      },
    });
  });

  it('rejects null value', () => {
    const result = UpdatePreferencesSchema.safeParse({ marketingEmailsOptedIn: null });
    expect(result).toMatchObject({
      success: false,
      error: {
        issues: [
          {
            code: 'invalid_type',
            path: ['marketingEmailsOptedIn'],
            message: 'Invalid input: expected boolean, received null',
          },
        ],
      },
    });
  });

  it('strips unknown fields', () => {
    const result = UpdatePreferencesSchema.safeParse({
      marketingEmailsOptedIn: true,
      extraField: 'ignored',
    });
    expect(result).toStrictEqual({ success: true, data: { marketingEmailsOptedIn: true } });
  });
});
