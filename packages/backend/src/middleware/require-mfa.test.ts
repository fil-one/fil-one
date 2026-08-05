import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetMfaEnrollments = vi.fn();
vi.mock('../lib/auth0-management.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/auth0-management.js')>()),
  getMfaEnrollments: (sub: string) => mockGetMfaEnrollments(sub),
}));

import { requireMfa, requireMfaIfEnrolled } from './require-mfa.js';
import type { IdTokenClaims } from './auth.js';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';

function buildRequest(claims?: Partial<IdTokenClaims>) {
  const event = buildEvent({
    method: 'POST',
    userInfo: { sub: 'auth0|user-1', userId: 'user-1', orgId: 'org-1' },
  });
  const internal: Record<string, unknown> = {};
  if (claims) {
    internal.idTokenClaims = {
      email: null,
      emailVerified: false,
      name: null,
      picture: null,
      amr: [],
      ...claims,
    } satisfies IdTokenClaims;
  }
  return buildMiddyRequest(event, { internal });
}

describe('requireMfa', () => {
  it('passes when amr contains "mfa"', async () => {
    const result = await requireMfa().before(buildRequest({ amr: ['mfa'] }));

    expect(result).toBeUndefined();
  });

  it('passes when amr contains "mfa" alongside other methods', async () => {
    const result = await requireMfa().before(buildRequest({ amr: ['pwd', 'mfa'] }));

    expect(result).toBeUndefined();
  });

  it('passes when amr contains "phr" (passkey login satisfies step-up)', async () => {
    const result = await requireMfa().before(buildRequest({ amr: ['phr'] }));

    expect(result).toBeUndefined();
  });

  it('passes when amr contains "phr" alongside other methods', async () => {
    const result = await requireMfa().before(buildRequest({ amr: ['pwd', 'phr'] }));

    expect(result).toBeUndefined();
  });

  it('returns 401 step_up_required when amr is empty', async () => {
    const result = await requireMfa().before(buildRequest({ amr: [] }));

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
  });

  it('returns 401 when amr does not contain "mfa"', async () => {
    const result = await requireMfa().before(buildRequest({ amr: ['pwd'] }));

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
  });

  it('returns 401 when authMiddleware did not stash any claims', async () => {
    const result = await requireMfa().before(buildRequest());

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
  });
});

describe('requireMfaIfEnrolled', () => {
  beforeEach(() => {
    mockGetMfaEnrollments.mockReset();
  });

  it('passes on a strong-auth session (amr mfa) without consulting Auth0', async () => {
    const result = await requireMfaIfEnrolled().before(buildRequest({ amr: ['mfa'] }));

    expect(result).toBeUndefined();
    expect(mockGetMfaEnrollments).not.toHaveBeenCalled();
  });

  it('passes on a passkey session (amr phr) without consulting Auth0', async () => {
    const result = await requireMfaIfEnrolled().before(buildRequest({ amr: ['pwd', 'phr'] }));

    expect(result).toBeUndefined();
    expect(mockGetMfaEnrollments).not.toHaveBeenCalled();
  });

  it('returns 401 step_up_required when the user has MFA enrolled but no strong-auth amr', async () => {
    mockGetMfaEnrollments.mockResolvedValue([{ id: 'e1', type: 'authenticator' }]);

    const result = await requireMfaIfEnrolled().before(buildRequest({ amr: ['pwd'] }));

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
    expect(mockGetMfaEnrollments).toHaveBeenCalledWith('auth0|user-1');
  });

  it('passes when the user has no MFA enrollments', async () => {
    mockGetMfaEnrollments.mockResolvedValue([]);

    const result = await requireMfaIfEnrolled().before(buildRequest({ amr: ['pwd'] }));

    expect(result).toBeUndefined();
  });

  it('ignores enrollment types outside MFA_GUARDIAN_TYPES', async () => {
    mockGetMfaEnrollments.mockResolvedValue([{ id: 'e1', type: 'email' }]);

    const result = await requireMfaIfEnrolled().before(buildRequest({ amr: ['pwd'] }));

    expect(result).toBeUndefined();
  });

  it('fails closed: a Management API error propagates instead of skipping the gate', async () => {
    mockGetMfaEnrollments.mockRejectedValue(new Error('auth0 down'));

    await expect(requireMfaIfEnrolled().before(buildRequest({ amr: ['pwd'] }))).rejects.toThrow(
      'auth0 down',
    );
  });
});
