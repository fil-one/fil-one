import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  clearActiveOrgId,
  getActiveOrgId,
  reconcileActiveOrg,
  setActiveOrgId,
  switchToOrg,
  takeReconcileNotice,
} from './active-org.js';
import { queryClient, queryKeys } from './query-client.js';
import { cancelGuardedWork, holdLeaveGuard } from './use-warn-before-unload.js';

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
    it('stashes the choice and clears the cache ahead of the navigation, seeding no display it was not given', () => {
      const clearSpy = vi.spyOn(queryClient, 'clear');

      switchToOrg(ORG_B);

      expect(getActiveOrgId()).toBe(ORG_B);
      // Org A's data cannot leak into org B's view.
      expect(clearSpy).toHaveBeenCalled();
      expect(queryClient.getQueryData(queryKeys.pendingOrgSwitch)).toBeUndefined();
    });

    it('navigates to the dashboard, which the stash now answers for', async () => {
      switchToOrg(ORG_B);

      await vi.waitFor(() => {
        expect(navigate).toHaveBeenCalledWith({ to: '/dashboard' });
      });
      // Not the old full-reload mechanism at all.
      expect(assign).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });

    it('lands on get-started, not the dashboard, when told to', async () => {
      // Creating an org: the new one is empty, so it opens on its setup page
      // rather than a dashboard of zeroes.
      switchToOrg(ORG_B, 'get-started');

      await vi.waitFor(() => {
        expect(navigate).toHaveBeenCalledWith({ to: '/get-started' });
      });
    });

    it('seeds the pending switch target from knownDisplay, so the sidebar has a name before /me answers', () => {
      switchToOrg(ORG_B, 'dashboard', {
        orgName: 'Globex',
        logoUrl: 'https://x/logo.png',
      });

      expect(queryClient.getQueryData(queryKeys.pendingOrgSwitch)).toEqual({
        orgId: ORG_B,
        orgName: 'Globex',
        logoUrl: 'https://x/logo.png',
      });
    });

    it('clears the pending switch target once the navigation settles', async () => {
      switchToOrg(ORG_B, 'dashboard', { orgName: 'Globex' });
      expect(queryClient.getQueryData(queryKeys.pendingOrgSwitch)).toBeTruthy();

      await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

      expect(queryClient.getQueryData(queryKeys.pendingOrgSwitch)).toBeNull();
    });

    it('clears the pending switch target on rollback too', async () => {
      navigate.mockRejectedValue(new Error('navigation blocked'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      switchToOrg(ORG_B, 'dashboard', { orgName: 'Globex' });
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

    it('asks before cancelling a running upload, and changes nothing when declined', () => {
      setActiveOrgId(ORG_A);
      const clearSpy = vi.spyOn(queryClient, 'clear');
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const cancel = vi.fn();
      const release = holdLeaveGuard(cancel);

      expect(switchToOrg(ORG_B)).toBe(false);
      expect(cancel).not.toHaveBeenCalled();

      // A client-side switch fires no `beforeunload`, so this is the only
      // question the user gets before the switch goes ahead.
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(getActiveOrgId()).toBe(ORG_A);
      expect(clearSpy).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      release();
    });

    it('cancels the upload before switching once the user agrees to leave it', () => {
      setActiveOrgId(ORG_A);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      // The upload's later batches read the stash when they go out, so it has to
      // stop while the stash still names the org it started in.
      const stashWhenCancelled: Array<string | null> = [];
      const cancel = vi.fn(() => stashWhenCancelled.push(getActiveOrgId()));
      const release = holdLeaveGuard(cancel);

      expect(switchToOrg(ORG_B)).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(stashWhenCancelled).toEqual([ORG_A]);
      expect(getActiveOrgId()).toBe(ORG_B);
      release();
    });

    it('asks nothing once the upload has finished', () => {
      const confirm = vi.spyOn(window, 'confirm');
      const release = holdLeaveGuard(vi.fn());
      release();

      expect(switchToOrg(ORG_B)).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    });

    // Cancelled work is on its way out; a caller that stops it and then moves
    // the tab (leaving an org does exactly this) is not asked about it.
    it('asks nothing about work that was just cancelled', () => {
      const confirm = vi.spyOn(window, 'confirm');
      const cancel = vi.fn();
      const release = holdLeaveGuard(cancel);

      cancelGuardedWork();

      expect(cancel).toHaveBeenCalledOnce();
      expect(switchToOrg(ORG_B)).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      release();
    });

    it('clears the stash on rollback when there was no previous org', async () => {
      navigate.mockRejectedValue(new Error('navigation blocked'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      switchToOrg(ORG_B);
      await vi.waitFor(() => expect(getActiveOrgId()).toBeNull());
    });
  });
});

describe('the active org stash: reconciling what the server resolved', () => {
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

  // Its later requests would otherwise go out with no header, into whatever
  // org the server resolves instead, if the user declined the reload.
  it('stops running work without asking before it reloads', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const confirm = vi.spyOn(window, 'confirm');
    const cancel = vi.fn();
    holdLeaveGuard(cancel);
    setActiveOrgId(ORG_A);

    reconcileActiveOrg(ORG_B, ORG_A);

    expect(cancel).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
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

  it('stops running work headed into the refused org', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stash = await freshStash();
    const { holdLeaveGuard: hold } = await import('./use-warn-before-unload.js');
    const cancel = vi.fn();
    hold(cancel);
    stash.setActiveOrgId(ORG_A);

    stash.clearActiveOrgAfterRefusal(403);

    expect(cancel).toHaveBeenCalledOnce();
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

describe('a recovery reload that never happens', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.resetModules();
    vi.useFakeTimers();
    reload.mockClear();
    assign.mockClear();
    vi.stubGlobal('location', { reload, assign });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Fresh module: the latch is module state, as a page load is. */
  async function reconciledStash() {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stash = await import('./active-org.js');
    stash.setActiveOrgId(ORG_A);
    expect(stash.reconcileActiveOrg(ORG_B, ORG_A)).toBe(true);
    return stash;
  }

  it('does not hand back an org the server refused', async () => {
    // `/me` answered under another org, and the reload that recovery asks for
    // was cancelled. Putting the stash back would re-attach the header the
    // server has already declined to every later request, and each one would
    // come back NOT_A_MEMBER — the state the clear exists to leave behind.
    const stash = await reconciledStash();
    await vi.runAllTimersAsync();

    expect(stash.getActiveOrgId()).toBeNull();
    expect(stash.isSwitchingOrg()).toBe(false);
  });

  it('does not hand back an org /me refused outright', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stash = await import('./active-org.js');
    stash.setActiveOrgId(ORG_A);

    expect(stash.clearActiveOrgAfterRefusal(403)).toBe(true);
    await vi.runAllTimersAsync();

    // `/me` is the one call whose answer could fix this tab, and it is refusing
    // the header. The tab carries on in the caller's own org instead.
    expect(stash.getActiveOrgId()).toBeNull();
    expect(stash.isSwitchingOrg()).toBe(false);
  });

  it('stays latched when the page really is leaving', async () => {
    const stash = await reconciledStash();

    window.dispatchEvent(new Event('pagehide'));
    await vi.runAllTimersAsync();

    // The load is on its way: releasing the latch here would let requests out
    // under the page that is about to be replaced.
    expect(stash.isSwitchingOrg()).toBe(true);
  });

  it('reloads a page that comes back out of the back/forward cache', async () => {
    // Same document, same heap: the latch is still up and the rollback timer is
    // gone, so every request would be held and the switcher would stay
    // disabled. The page is showing an org the user has left.
    await reconciledStash();
    reload.mockClear();

    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));

    expect(reload).toHaveBeenCalled();
  });

  it('leaves an ordinary load alone', async () => {
    await reconciledStash();
    reload.mockClear();

    window.dispatchEvent(new Event('pagehide'));
    // A `pageshow` without `persisted` is a fresh document, which has no latch
    // to clear and nothing to reload.
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));

    expect(reload).not.toHaveBeenCalled();
  });
});
