import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiErrorCode, ORG_ID_HEADER } from '@filone/shared';

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

/**
 * Fresh module graph per test: the org-switch latch and the once-per-load stash
 * clear are module state, because a page load is what resets them.
 */
async function freshApi() {
  vi.resetModules();
  return {
    api: await import('./api.js'),
    stash: await import('./active-org.js'),
  };
}

describe('apiRequest — a switch in flight', () => {
  const ORG_A = '11111111-1111-1111-1111-111111111111';
  const ORG_B = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('location', { assign: vi.fn(), reload: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('issues nothing once the tab is on its way to another org', async () => {
    const { api, stash } = await freshApi();
    stash.switchToOrg(ORG_B);

    const held = api.apiRequest('/buckets');
    const settled = await Promise.race([held.then(() => 'settled'), Promise.resolve('pending')]);

    // The answer would be discarded by the navigation either way; held rather
    // than rejected so no error renders over a page that is disappearing.
    expect(settled).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends a held request in the org still on screen once the switch rolls back', async () => {
    // The switch was cancelled — a `beforeunload` guard, and a user who
    // answered "stay on this page". A request handed out inside that window has
    // no other resolution path: React Query starts no second fetch for a key
    // whose fetch is still in flight, so the panel would spin until a reload.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api, stash } = await freshApi();
    stash.setActiveOrgId(ORG_A);
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ buckets: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    stash.switchToOrg(ORG_B);
    const held = api.apiRequest('/buckets');

    await vi.runAllTimersAsync();

    await expect(held).resolves.toStrictEqual({ buckets: [] });
    // The rollback put ORG_A back before the request read the stash, so the
    // call names the org the page is still showing.
    const sent = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Headers;
    expect(sent.get(ORG_ID_HEADER)).toBe(ORG_A);
  });
});

describe('getMe — when /me itself refuses', () => {
  const ORG_A = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('location', { assign: vi.fn(), reload: vi.fn() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('drops the stash when the org header is what was refused', async () => {
    const { api, stash } = await freshApi();
    stash.setActiveOrgId(ORG_A);
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: 'not a member' }), { status: 403 }),
    );

    await expect(api.getMe()).rejects.toThrow();

    // `/me` is the only carrier of the echo that clears a stale stash, so a
    // refusal from it would otherwise leave the tab naming the same org forever.
    expect(stash.getActiveOrgId()).toBeNull();
  });

  it('keeps the stash when /me failed on its own', async () => {
    const { api, stash } = await freshApi();
    stash.setActiveOrgId(ORG_A);
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: 'nope' }), { status: 503 }),
    );

    await expect(api.getMe()).rejects.toThrow();

    // The query client retries a 5xx. Clearing here would send the retry with no
    // header, the server would answer under the identity-row org, and the tab
    // would silently rescope with the other org's data still on screen.
    expect(stash.getActiveOrgId()).toBe(ORG_A);
  });

  it('leaves a good stash alone when the call succeeds', async () => {
    const { api, stash } = await freshApi();
    stash.setActiveOrgId(ORG_A);
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ orgId: ORG_A }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await api.getMe();

    expect(stash.getActiveOrgId()).toBe(ORG_A);
  });
});

describe('logout', () => {
  const ORG_A = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.stubGlobal('location', { href: '' });
  });

  afterEach(() => {
    // The give-up timeout is what takes the `pagehide` listener off the window,
    // and the window outlives the module reload each case starts with.
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('drops the org this tab was operating in when the navigation commits', async () => {
    const { api, stash } = await freshApi();
    stash.setActiveOrgId(ORG_A);

    api.logout();
    window.dispatchEvent(new Event('pagehide'));

    // sessionStorage belongs to the tab, and logging out is a same-tab
    // navigation: on a shared machine the next user would otherwise start
    // inside the previous user's org.
    expect(stash.getActiveOrgId()).toBeNull();
  });

  it('keeps the org when the logout is cancelled', async () => {
    // The upload page's `beforeunload` guard covers every way out of the page,
    // logout included. A user who answers "stay on this page" would otherwise
    // be left rendering org B with no stash, and every later request — a delete
    // among them — would land in their personal org.
    const { api, stash } = await freshApi();
    stash.setActiveOrgId(ORG_A);

    api.logout();

    expect(stash.getActiveOrgId()).toBe(ORG_A);
  });

  it('stops waiting for a logout navigation that never comes', async () => {
    const { api, stash } = await freshApi();
    stash.setActiveOrgId(ORG_A);

    api.logout();
    await vi.advanceTimersByTimeAsync(10_000);
    // A later navigation is a different trip, and must not carry out the clear
    // this one asked for.
    window.dispatchEvent(new Event('pagehide'));

    expect(stash.getActiveOrgId()).toBe(ORG_A);
  });
});
