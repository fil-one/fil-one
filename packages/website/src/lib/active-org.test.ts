import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  clearActiveOrgId,
  getActiveOrgId,
  reconcileActiveOrg,
  setActiveOrgId,
  switchToOrg,
} from './active-org.js';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const reload = vi.fn();

describe('the active org stash', () => {
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockClear();
    // Only `reload` is read on these paths, so the stub carries nothing else.
    vi.stubGlobal('location', { reload });
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
    it('stashes the choice and reloads the tab', () => {
      switchToOrg(ORG_B);

      expect(getActiveOrgId()).toBe(ORG_B);
      // No query key carries an org dimension, so a reload is the only
      // invalidation that cannot leak one org's cache into the other's view.
      expect(reload).toHaveBeenCalledTimes(1);
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
