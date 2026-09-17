import { describe, it, expect } from 'vitest';
import {
  DeleteAccountSchema,
  DeletionCodeSchema,
  DELETION_CODE_LENGTH,
} from './account-deletion.ts';

describe('DeletionCodeSchema', () => {
  it.each(['000000', '123456', '999999'])('accepts "%s"', (code) => {
    expect(DeletionCodeSchema.parse(code)).toBe(code);
  });

  it('trims surrounding whitespace', () => {
    expect(DeletionCodeSchema.parse(' 123456 ')).toBe('123456');
  });

  it.each([
    ['too short', '12345'],
    ['too long', '1234567'],
    ['non-digits', '12a456'],
    ['empty', ''],
    ['internal space', '123 56'],
  ])('rejects %s', (_label, code) => {
    expect(DeletionCodeSchema.safeParse(code).success).toBe(false);
  });

  it('is exactly DELETION_CODE_LENGTH digits', () => {
    expect(DeletionCodeSchema.safeParse('1'.repeat(DELETION_CODE_LENGTH)).success).toBe(true);
    expect(DeletionCodeSchema.safeParse('1'.repeat(DELETION_CODE_LENGTH + 1)).success).toBe(false);
  });
});

describe('DeleteAccountSchema', () => {
  it('accepts a code and an org name', () => {
    expect(DeleteAccountSchema.parse({ code: '123456', orgName: ' Acme Corp ' })).toEqual({
      code: '123456',
      orgName: 'Acme Corp',
    });
  });

  it('accepts an org name the current OrgNameSchema rules would reject', () => {
    expect(DeleteAccountSchema.safeParse({ code: '123456', orgName: "Acme & Co's" }).success).toBe(
      true,
    );
  });

  it.each([
    ['a missing code', { orgName: 'Acme' }],
    ['a missing org name', { code: '123456' }],
    ['a blank org name', { code: '123456', orgName: '   ' }],
    ['a malformed code', { code: 'abcdef', orgName: 'Acme' }],
  ])('rejects %s', (_label, body) => {
    expect(DeleteAccountSchema.safeParse(body).success).toBe(false);
  });
});
