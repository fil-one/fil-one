import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  clearActiveOrgId,
  getActiveOrgId,
  reconcileActiveOrg,
  setActiveOrgId,
  switchToOrg,
  takeReconcileNotice,
} from './active-org.js';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const reload = vi.fn();
const assign = vi.fn();

describe('the active org stash', () => {
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockClear();
    assign.mockClear();
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
    it('stashes the choice and loads the console root', () => {
      switchToOrg(ORG_B);

      expect(getActiveOrgId()).toBe(ORG_B);
      // No query key carries an org dimension, so a fresh load is the only
      // invalidation that cannot leak one org's cache into the other's view —
      // and the root, because every path segment is org-scoped.
      expect(assign).toHaveBeenCalledWith('/');
      expect(reload).not.toHaveBeenCalled();
    });
  });

  describe('reconciling what the server resolved', () => {
    it('does nothing when the two agree', () => {
      setActiveOrgId(ORG_A);

      expect(reconcileActiveOrg(ORG_A)).toBe(false);
      expect(getActiveOrgId()).toBe(ORG_A);
      expect(reload).not.toHaveBeenCalled();
    });

    it('clears the stash and reloads when they disagree', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setActiveOrgId(ORG_A);

      // The stash names an org the caller was removed from, or a proxy dropped
      // the header: every request this tab makes is landing in the wrong org.
      expect(reconcileActiveOrg(ORG_B)).toBe(true);
      expect(getActiveOrgId()).toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
    });

    it('leaves a notice for the load that follows', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      setActiveOrgId(ORG_A);
      reconcileActiveOrg(ORG_B);

      // Otherwise a header a proxy keeps stripping turns every switcher click
      // into a reload that lands back where it started, indistinguishable from
      // a switch that worked.
      expect(takeReconcileNotice()).toBe(true);
      // Once: the flag is spent, not repeated on every later load.
      expect(takeReconcileNotice()).toBe(false);
    });

    it('leaves no notice when nothing was reconciled', () => {
      setActiveOrgId(ORG_A);
      reconcileActiveOrg(ORG_A);

      expect(takeReconcileNotice()).toBe(false);
    });

    it('cannot loop, because the reload sends no header', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      setActiveOrgId(ORG_A);
      reconcileActiveOrg(ORG_B);

      // The next load has no stash, so the server answers under the caller's own
      // org and there is nothing left to mismatch.
      expect(reconcileActiveOrg(ORG_B)).toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the tab asked for no org', () => {
      expect(reconcileActiveOrg(ORG_B)).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    });

    it('does nothing when the response named no org', () => {
      setActiveOrgId(ORG_A);

      expect(reconcileActiveOrg(undefined)).toBe(false);
      expect(getActiveOrgId()).toBe(ORG_A);
      expect(reload).not.toHaveBeenCalled();
    });
  });
});

describe('recovering from a /me that refuses', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
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

    expect(stash.clearActiveOrgAfterRefusal()).toBe(true);
    expect(stash.getActiveOrgId()).toBeNull();
  });

  it('does it once per page load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stash = await freshStash();
    stash.setActiveOrgId(ORG_A);
    stash.clearActiveOrgAfterRefusal();
    stash.setActiveOrgId(ORG_B);

    // A `/me` failing for its own reasons must not turn into a tab that clears
    // and retries without end.
    expect(stash.clearActiveOrgAfterRefusal()).toBe(false);
    expect(stash.getActiveOrgId()).toBe(ORG_B);
  });

  it('does nothing when the tab had no stash', async () => {
    const stash = await freshStash();

    expect(stash.clearActiveOrgAfterRefusal()).toBe(false);
  });
});
