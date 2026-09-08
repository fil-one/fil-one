import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MeResponse } from '@filone/shared';

import {
  clearActiveOrgId,
  getActiveOrgId,
  reconcileActiveOrg,
  setActiveOrgId,
  switchToOrg,
  takeReconcileNotice,
} from './active-org.js';
import { queryClient, queryKeys } from './query-client.js';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const reload = vi.fn();
const assign = vi.fn();
const navigate = vi.fn();

// `switchToOrg` imports the router dynamically (see its own comment for why),
// so this is what it gets back either way.
vi.mock('../router.js', () => ({
  router: { navigate: (...args: unknown[]) => navigate(...args) },
}));

describe('the active org stash', () => {
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockClear();
    assign.mockClear();
    navigate.mockReset();
    navigate.mockResolvedValue(undefined);
    queryClient.clear();
    // Only `reload` and `assign` are read on these paths, so the stub carries
    // nothing else.
    vi.stubGlobal('location', { reload, assign });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('round-trips a stored org', () => {
    setActiveOrgId(ORG_A);
    expect(getActiveOrgId()).toBe(ORG_A);
  });

  it('is empty before anything is stored', () => {
    expect(getActiveOrgId()).toBeNull();
  });

  it('clears', () => {
    setActiveOrgId(ORG_A);
    clearActiveOrgId();
    expect(getActiveOrgId()).toBeNull();
  });

  it('survives storage being unavailable', () => {
    const failing = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    // Private mode: no stash, so every request goes to the caller's own org —
    // which is what a caller with no stash gets anyway.
    expect(() => setActiveOrgId(ORG_A)).not.toThrow();
    expect(getActiveOrgId()).toBeNull();
    failing.mockRestore();
  });

  describe('switching', () => {
    function seedMe(overrides: Partial<MeResponse>) {
      queryClient.setQueryData(queryKeys.me, {
        orgId: ORG_A,
        memberships: [],
        ...overrides,
      } as unknown as MeResponse);
    }

    it('stashes the choice immediately, ahead of the navigation settling', () => {
      switchToOrg(ORG_B);

      expect(getActiveOrgId()).toBe(ORG_B);
    });

    it('clears every cached query, so org A’s data cannot leak into org B’s view', () => {
      const clearSpy = vi.spyOn(queryClient, 'clear');

      switchToOrg(ORG_B);

      expect(clearSpy).toHaveBeenCalled();
    });

    it('navigates to the target org’s dashboard by slug, once this tab’s cache knows it', async () => {
      seedMe({
        memberships: [
          { orgId: ORG_A, orgName: 'A', role: 'owner', slug: 'org-a' } as never,
          { orgId: ORG_B, orgName: 'B', role: 'owner', slug: 'org-b' } as never,
        ],
      });

      switchToOrg(ORG_B);

      await vi.waitFor(() => {
        expect(navigate).toHaveBeenCalledWith({
          to: '/$orgSlug/dashboard',
          params: { orgSlug: 'org-b' },
        });
      });
      // Not the old full-reload mechanism at all.
      expect(assign).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });

    it('navigates by a known slug even when the target org is not in any cache yet', async () => {
      // No `/me` seeded at all - the state right after accepting an
      // invitation or creating an org, where the target was never in this
      // tab's cache to begin with. The caller's own response already named
      // the slug, so there is no need to fall back to the unscoped dashboard.
      switchToOrg(ORG_B, 'org-b');

      await vi.waitFor(() => {
        expect(navigate).toHaveBeenCalledWith({
          to: '/$orgSlug/dashboard',
          params: { orgSlug: 'org-b' },
        });
      });
    });

    it('lands on get-started, not the dashboard, when told to', async () => {
      // Creating an org: the new one is empty, so it opens on its setup page
      // rather than a dashboard of zeroes. The slug comes straight off the
      // create response, the same way an invitation accept passes it.
      switchToOrg(ORG_B, 'org-b', 'get-started');

      await vi.waitFor(() => {
        expect(navigate).toHaveBeenCalledWith({
          to: '/$orgSlug/get-started',
          params: { orgSlug: 'org-b' },
        });
      });
    });

    it('falls back to the unscoped dashboard when the target org has no slug yet', async () => {
      // No `/me` cached at all — the state before the backend's slug backfill
      // has run for this stage, or simply before the first `/me` of the
      // session. Either way there is nothing to resolve a slug from.
      switchToOrg(ORG_B);

      await vi.waitFor(() => {
        expect(navigate).toHaveBeenCalledWith({ to: '/dashboard' });
      });
    });

    it('seeds the pending switch target from knownDisplay, so the sidebar has a name before /me answers', () => {
      switchToOrg(ORG_B, 'org-b', 'dashboard', {
        orgName: 'Globex',
        logoUrl: 'https://x/logo.png',
      });

      expect(queryClient.getQueryData(queryKeys.pendingOrgSwitch)).toEqual({
        orgId: ORG_B,
        orgName: 'Globex',
        logoUrl: 'https://x/logo.png',
      });
    });

    it('seeds nothing when the caller has no display info on hand', () => {
      switchToOrg(ORG_B, 'org-b');

      expect(queryClient.getQueryData(queryKeys.pendingOrgSwitch)).toBeUndefined();
    });

    it('clears the pending switch target once the navigation settles', async () => {
      seedMe({
        memberships: [{ orgId: ORG_B, orgName: 'B', role: 'owner', slug: 'org-b' } as never],
      });
      switchToOrg(ORG_B, 'org-b', 'dashboard', { orgName: 'Globex' });
      expect(queryClient.getQueryData(queryKeys.pendingOrgSwitch)).toBeTruthy();

      await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

      expect(queryClient.getQueryData(queryKeys.pendingOrgSwitch)).toBeNull();
    });

    it('clears the pending switch target on rollback too', async () => {
      navigate.mockRejectedValue(new Error('navigation blocked'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      switchToOrg(ORG_B, 'org-b', 'dashboard', { orgName: 'Globex' });
      await vi.waitFor(() => expect(getActiveOrgId()).not.toBe(ORG_B));

      expect(queryClient.getQueryData(queryKeys.pendingOrgSwitch)).toBeNull();
    });

    it('rolls the stash back when the navigation does not complete', async () => {
      setActiveOrgId(ORG_A);
      navigate.mockRejectedValue(new Error('navigation blocked'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      switchToOrg(ORG_B);
      expect(getActiveOrgId()).toBe(ORG_B);

      await vi.waitFor(() => expect(getActiveOrgId()).toBe(ORG_A));
    });

    it('clears the stash on rollback when there was no previous org', async () => {
      navigate.mockRejectedValue(new Error('navigation blocked'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      switchToOrg(ORG_B);
      await vi.waitFor(() => expect(getActiveOrgId()).toBeNull());
    });
  });

  describe('reconciling what the server resolved', () => {
    it('does nothing when the two agree', () => {
      setActiveOrgId(ORG_A);

      expect(reconcileActiveOrg(ORG_A, ORG_A)).toBe(false);
      expect(getActiveOrgId()).toBe(ORG_A);
      expect(reload).not.toHaveBeenCalled();
    });

    it('clears the stash and reloads when they disagree', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setActiveOrgId(ORG_A);

      // The stash names an org the caller was removed from, or a proxy dropped
      // the header: every request this tab makes is landing in the wrong org.
      expect(reconcileActiveOrg(ORG_B, ORG_A)).toBe(true);
      expect(getActiveOrgId()).toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
    });

    it('leaves a notice for the load that follows', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      setActiveOrgId(ORG_A);
      reconcileActiveOrg(ORG_B, ORG_A);

      // Otherwise a header a proxy keeps stripping turns every switcher click
      // into a reload that lands back where it started, indistinguishable from
      // a switch that worked.
      expect(takeReconcileNotice()).toBe(true);
      // Once: the flag is spent, not repeated on every later load.
      expect(takeReconcileNotice()).toBe(false);
    });

    it('leaves no notice when nothing was reconciled', () => {
      setActiveOrgId(ORG_A);
      reconcileActiveOrg(ORG_A, ORG_A);

      expect(takeReconcileNotice()).toBe(false);
    });

    it('cannot loop, because the reload sends no header', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      setActiveOrgId(ORG_A);
      reconcileActiveOrg(ORG_B, ORG_A);

      // The next load has no stash, so the server answers under the caller's own
      // org and there is nothing left to mismatch.
      expect(reconcileActiveOrg(ORG_B, null)).toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('ignores an echo for the org the tab has since left', () => {
      setActiveOrgId(ORG_A);
      // `/me` went out under ORG_A and the switcher stashed ORG_B while it was
      // in flight. Read against the new stash, an honest echo looks like a
      // refusal, and clearing would undo the switch the user just made.
      setActiveOrgId(ORG_B);

      expect(reconcileActiveOrg(ORG_A, ORG_A)).toBe(false);
      expect(getActiveOrgId()).toBe(ORG_B);
      expect(reload).not.toHaveBeenCalled();
    });

    it('does nothing when the tab asked for no org', () => {
      expect(reconcileActiveOrg(ORG_B, null)).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    });

    it('does nothing when the response named no org', () => {
      setActiveOrgId(ORG_A);

      expect(reconcileActiveOrg(undefined, ORG_A)).toBe(false);
      expect(getActiveOrgId()).toBe(ORG_A);
      expect(reload).not.toHaveBeenCalled();
    });
  });
});

describe('recovering from a /me that refuses', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.resetModules();
    reload.mockClear();
    assign.mockClear();
    vi.stubGlobal('location', { reload, assign });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Fresh module: the once-per-load latch is module state, as a page load is. */
  async function freshStash() {
    return import('./active-org.js');
  }

  it('drops the stash so the next load asks for nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stash = await freshStash();
    stash.setActiveOrgId(ORG_A);

    expect(stash.clearActiveOrgAfterRefusal(403)).toBe(true);
    expect(stash.getActiveOrgId()).toBeNull();
  });

  it('reloads, so data for the org this tab has left does not outlive it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stash = await freshStash();
    stash.setActiveOrgId(ORG_A);

    stash.clearActiveOrgAfterRefusal(403);

    expect(reload).toHaveBeenCalledTimes(1);
    // And the page that comes back says why it changed under the user.
    expect(stash.takeReconcileNotice()).toBe(true);
  });

  it.each([500, 502, undefined])(
    'keeps the stash when /me failed on its own (%s)',
    async (status) => {
      // The query client retries a 5xx and a network error. Clearing on one sent
      // the retry with no header, the server answered under the identity-row org,
      // and org B's data stayed on screen while every later request landed
      // somewhere else.
      const stash = await freshStash();
      stash.setActiveOrgId(ORG_A);

      expect(stash.clearActiveOrgAfterRefusal(status)).toBe(false);
      expect(stash.getActiveOrgId()).toBe(ORG_A);
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it('does it once per page load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stash = await freshStash();
    stash.setActiveOrgId(ORG_A);
    stash.clearActiveOrgAfterRefusal(403);
    stash.setActiveOrgId(ORG_B);

    // A `/me` refusing for its own reasons must not turn into a tab that clears
    // and retries without end.
    expect(stash.clearActiveOrgAfterRefusal(403)).toBe(false);
    expect(stash.getActiveOrgId()).toBe(ORG_B);
  });

  it('does nothing when the tab had no stash', async () => {
    const stash = await freshStash();

    expect(stash.clearActiveOrgAfterRefusal(403)).toBe(false);
  });
});
