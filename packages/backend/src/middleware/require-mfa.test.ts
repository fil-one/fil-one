import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetMfaEnrollments = vi.fn();
vi.mock('../lib/auth0-management.js', () => ({
  getMfaEnrollments: (sub: string) => mockGetMfaEnrollments(sub),
}));

import { requireMfa, requireMfaIfEnrolled, STEP_UP_MAX_AGE_SECONDS } from './require-mfa.js';
import type { IdTokenClaims } from './auth.js';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';
import { expectRefreshedCookies, REFRESHED_TOKENS } from '../test/assert-helpers.js';

function buildRequest(claims?: Partial<IdTokenClaims>) {
  // With a caller on it: the enrolled-user branch reads the session's `sub` to
  // ask Auth0 what they have enrolled.
  const event = buildEvent({
    method: 'POST',
    userInfo: { userId: 'user-1', orgId: 'org-1', sub: 'auth0|user-1' },
  });
  const internal: Record<string, unknown> = {};
  if (claims) {
    internal.idTokenClaims = {
      email: null,
      emailVerified: false,
      name: null,
      picture: null,
      amr: [],
      authTime: null,
      auth0OrgId: null,
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

  it('carries the rotated cookies on the step-up prompt', async () => {
    // The step-up round trip sends the caller back through Auth0. Dropping the
    // cookies this request rotated would make that a full logout instead.
    const request = buildRequest({ amr: ['pwd'] });
    request.internal.newTokens = REFRESHED_TOKENS;

    expectRefreshedCookies(await requireMfa().before(request));
  });
});

/**
 * The step-up variant the org actions use. `requireMfa` asks for an `amr` a
 * user with nothing enrolled can never produce; this one asks the question that
 * has an answer for everybody — have you proved yourself again, just now?
 */
describe('requireMfaIfEnrolled', () => {
  const secondsAgo = (seconds: number) => Math.floor(Date.now() / 1000) - seconds;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetMfaEnrollments.mockResolvedValue([]);
  });

  it.each([['mfa'], ['phr']])('passes on amr %s without asking Auth0 anything', async (method) => {
    const result = await requireMfaIfEnrolled().before(buildRequest({ amr: [method] }));

    expect(result).toBeUndefined();
    expect(mockGetMfaEnrollments).not.toHaveBeenCalled();
  });

  it('passes a fresh sign-in from a user with nothing enrolled', async () => {
    // The federated case: a SAML session never carries `mfa`, and Guardian holds
    // no enrollment to challenge, so re-authentication is the step-up.
    const result = await requireMfaIfEnrolled().before(
      buildRequest({ amr: ['pwd'], authTime: secondsAgo(10) }),
    );

    expect(result).toBeUndefined();
  });

  it('refuses a fresh sign-in from a user who has MFA enrolled', async () => {
    mockGetMfaEnrollments.mockResolvedValue([{ id: 'enrollment-1' }]);

    const result = await requireMfaIfEnrolled().before(
      buildRequest({ amr: ['pwd'], authTime: secondsAgo(10) }),
    );

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'step_up_required' }),
    });
  });

  it('refuses a session with no auth_time at all', async () => {
    const result = await requireMfaIfEnrolled().before(buildRequest({ amr: ['pwd'] }));

    expect(result).toMatchObject({ statusCode: 401 });
    expect(mockGetMfaEnrollments).not.toHaveBeenCalled();
  });

  it('treats the freshness window as the boundary it is', async () => {
    // A second either side of the window rather than exactly on it: the check
    // reads a live clock, so "exactly at the limit" is a millisecond race
    // rather than a behaviour worth pinning.
    const inside = await requireMfaIfEnrolled().before(
      buildRequest({ amr: ['pwd'], authTime: secondsAgo(STEP_UP_MAX_AGE_SECONDS - 1) }),
    );
    const outside = await requireMfaIfEnrolled().before(
      buildRequest({ amr: ['pwd'], authTime: secondsAgo(STEP_UP_MAX_AGE_SECONDS + 1) }),
    );

    expect(inside).toBeUndefined();
    expect(outside).toMatchObject({ statusCode: 401 });
  });

  it('lets a caller who just re-authenticated through when Auth0 will not answer', async () => {
    // Denying would loop a user with no MFA through a redirect that cannot
    // satisfy a check we are unable to make.
    mockGetMfaEnrollments.mockRejectedValue(new Error('Auth0 unavailable'));

    const result = await requireMfaIfEnrolled().before(
      buildRequest({ amr: ['pwd'], authTime: secondsAgo(10) }),
    );

    expect(result).toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it('carries the rotated cookies on the step-up prompt', async () => {
    const request = buildRequest({ amr: ['pwd'] });
    request.internal.newTokens = REFRESHED_TOKENS;

    expectRefreshedCookies(await requireMfaIfEnrolled().before(request));
  });
});
