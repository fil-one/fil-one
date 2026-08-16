import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiErrorCode } from '@filone/shared';

import { apiRequest, ForbiddenRoleError, NotAMemberError } from './api.js';

/**
 * How `apiRequest` renders a denial. The role codes get their own error types
 * because a component may want to tell the two states apart; every other 403
 * keeps the decorated-Error shape its callers already read.
 */
function forbiddenResponse(code: ApiErrorCode | undefined, message?: string): Response {
  return new Response(
    JSON.stringify({ ...(code ? { code } : {}), ...(message ? { message } : {}) }),
    {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

describe('apiRequest — 403 handling', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function respondWith(response: Response) {
    vi.mocked(fetch).mockResolvedValue(response);
  }

  it('throws a typed error for FORBIDDEN_ROLE, carrying the server message', async () => {
    respondWith(
      forbiddenResponse(ApiErrorCode.FORBIDDEN_ROLE, 'Your role does not permit deleteObject.'),
    );

    const error = await apiRequest('/presign').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ForbiddenRoleError);
    expect((error as ForbiddenRoleError).message).toBe('Your role does not permit deleteObject.');
    expect((error as ForbiddenRoleError).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect((error as ForbiddenRoleError).status).toBe(403);
  });

  it('throws a typed error for NOT_A_MEMBER', async () => {
    respondWith(forbiddenResponse(ApiErrorCode.NOT_A_MEMBER));

    const error = await apiRequest('/buckets').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NotAMemberError);
    // The two states have different fixes, so one must never be the other.
    expect(error).not.toBeInstanceOf(ForbiddenRoleError);
    expect((error as NotAMemberError).message).toBe('You are not a member of this organization.');
  });

  it('leaves the other 403s as they were', async () => {
    respondWith(forbiddenResponse(ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED));

    const error = await apiRequest('/buckets').catch((err: unknown) => err);

    expect(error).not.toBeInstanceOf(ForbiddenRoleError);
    expect((error as Error).message).toContain('grace period');
  });

  it('falls back to the server message for an unrecognized 403', async () => {
    respondWith(forbiddenResponse(undefined, 'CSRF validation failed'));

    const error = await apiRequest('/buckets').catch((err: unknown) => err);

    expect((error as Error).message).toBe('CSRF validation failed');
  });
});
