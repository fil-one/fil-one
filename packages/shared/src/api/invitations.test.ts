import { describe, it, expect } from 'vitest';
import { OrgRole } from './org.ts';
import {
  AcceptInvitationSchema,
  CreateInvitationSchema,
  INVITE_EXPIRY_DAYS,
  INVITE_TOKEN_MIN_LENGTH,
  MAX_PENDING_INVITATIONS_PER_ORG,
} from './invitations.ts';

describe('CreateInvitationSchema', () => {
  it.each(Object.values(OrgRole))('accepts an invitation to %s', (role) => {
    // The schema keeps values that are not roles out of a stored row; whether
    // the CALLER may invite that role is the ceiling check in the handler.
    const parsed = CreateInvitationSchema.safeParse({ email: 'person@example.com', role });

    expect(parsed).toMatchObject({ success: true });
  });

  it('trims the address but keeps its case, which is what the email goes to', () => {
    const parsed = CreateInvitationSchema.parse({
      email: '  Person@Example.com  ',
      role: OrgRole.Member,
    });

    expect(parsed.email).toBe('Person@Example.com');
  });

  it.each([
    [
      'a role that is not one of the four',
      { email: 'a@b.com', role: 'billing' },
      { code: 'invalid_value', path: ['role'] },
    ],
    ['no role', { email: 'a@b.com' }, { code: 'invalid_value', path: ['role'] }],
    [
      'an address that is not one',
      { email: 'not-an-email', role: OrgRole.Member },
      { code: 'invalid_format', format: 'email', path: ['email'] },
    ],
    ['no address', { role: OrgRole.Member }, { code: 'invalid_type', path: ['email'] }],
    [
      'an empty address',
      { email: '', role: OrgRole.Member },
      { code: 'invalid_format', format: 'email', path: ['email'] },
    ],
    [
      'an absurd address',
      { email: `${'a'.repeat(400)}@example.com`, role: OrgRole.Member },
      { code: 'too_big', path: ['email'] },
    ],
  ])('rejects %s', (_label, body, issue) => {
    expect(CreateInvitationSchema.safeParse(body)).toMatchObject({
      success: false,
      error: { issues: [issue] },
    });
  });

  it('answers a rejected address with something a form can show', () => {
    const parsed = CreateInvitationSchema.safeParse({
      email: 'not-an-email',
      role: OrgRole.Member,
    });

    expect(parsed).toMatchObject({
      success: false,
      error: {
        issues: [{ path: ['email'], message: expect.stringContaining('valid email address') }],
      },
    });
  });
});

describe('AcceptInvitationSchema', () => {
  it('accepts a token of the shape the mailer sends', () => {
    expect(AcceptInvitationSchema.safeParse({ token: 'a'.repeat(43) })).toMatchObject({
      success: true,
    });
  });

  it.each([
    ['a token too short to be one', { token: 'short' }, { code: 'too_small', path: ['token'] }],
    ['no token', {}, { code: 'invalid_type', path: ['token'] }],
    ['a pasted blob', { token: 'x'.repeat(500) }, { code: 'too_big', path: ['token'] }],
  ])('rejects %s', (_label, body, issue) => {
    expect(AcceptInvitationSchema.safeParse(body)).toMatchObject({
      success: false,
      error: { issues: [issue] },
    });
  });

  it('trims a token a mail client wrapped in whitespace', () => {
    const token = 'b'.repeat(INVITE_TOKEN_MIN_LENGTH);

    expect(AcceptInvitationSchema.parse({ token: `  ${token}  ` }).token).toBe(token);
  });
});

describe('invitation constants', () => {
  it('expires invitations after a fortnight and caps how many can be outstanding', () => {
    // Both numbers are load-bearing: the expiry is checked at read time rather
    // than by a TTL, and the cap is the only rate limit the invite path has.
    expect(INVITE_EXPIRY_DAYS).toBe(14);
    expect(MAX_PENDING_INVITATIONS_PER_ORG).toBe(25);
  });
});
