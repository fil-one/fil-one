import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiErrorCode } from '@filone/shared';

import { apiRequest, ForbiddenRoleError, getMe, NotAMemberError } from './api.js';
import { setActiveOrgId } from './active-org.js';

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

describe('apiRequest — the active org header', () => {
  const ORG_A = '11111111-1111-1111-1111-111111111111';
  const ORG_B = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function respondWithJson(body: unknown) {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  function sentHeaders(): Headers {
    return vi.mocked(fetch).mock.calls[0][1]?.headers as Headers;
  }

  it('names the stashed org on every call', async () => {
    setActiveOrgId(ORG_A);
    respondWithJson({});

    await apiRequest('/buckets');

    expect(sentHeaders().get('X-Org-Id')).toBe(ORG_A);
  });

  it('sends no header when the tab has no stash', async () => {
    respondWithJson({});

    await apiRequest('/buckets');

    // The server then serves the caller's own org, which is what a first visit
    // and every non-console client get.
    expect(sentHeaders().has('X-Org-Id')).toBe(false);
  });

  describe('the /me echo', () => {
    const reload = vi.fn();

    beforeEach(() => {
      reload.mockClear();
      // Only `reload` is read on these paths, so the stub carries nothing else.
      vi.stubGlobal('location', { reload });
    });

    it('leaves the stash alone when the server resolved the same org', async () => {
      setActiveOrgId(ORG_A);
      respondWithJson({ orgId: ORG_A, orgName: 'Acme' });

      const me = await getMe();

      expect(me.orgId).toBe(ORG_A);
      expect(sessionStorage.getItem('filone:activeOrgId')).toBe(ORG_A);
      expect(reload).not.toHaveBeenCalled();
    });

    it('clears the stash and reloads when the server resolved another org', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      setActiveOrgId(ORG_A);
      respondWithJson({ orgId: ORG_B, orgName: 'Other' });

      // A stale stash: /me answered under the caller's own org, so every other
      // request in this tab is being refused or served somewhere unintended.
      await getMe();

      expect(sessionStorage.getItem('filone:activeOrgId')).toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });
});
