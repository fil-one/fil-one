import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  hasPendingInviteToken,
  hasSignUpHint,
  readAndStripInviteTokenFromHash,
  resetTakenInviteToken,
  cacheInviteToken,
  getCachedInviteToken,
} from './invite-token.js';

const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('invite-token', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetTakenInviteToken();
    window.history.replaceState(null, '', '/invite/accept');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readAndStripInviteTokenFromHash', () => {
    it('reads the token and takes the fragment out of the URL', () => {
      window.history.replaceState(null, '', `/invite/accept#token=${TOKEN}`);

      expect(readAndStripInviteTokenFromHash()).toBe(TOKEN);
      expect(window.location.hash).toBe('');
      expect(window.location.pathname).toBe('/invite/accept');
    });

    it('strips the fragment before it returns, not after the caller acts on it', () => {
      window.history.replaceState(null, '', `/invite/accept#token=${TOKEN}`);
      const replaceState = vi.spyOn(window.history, 'replaceState');

      readAndStripInviteTokenFromHash();

      // The whole point of the fragment is that it never leaves the browser, and
      // that only holds while it is short-lived: nothing may read the URL between
      // the page loading and this call.
      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(replaceState.mock.calls[0][2]).toBe('/invite/accept');
    });

    it('keeps the query string it was given', () => {
      window.history.replaceState(null, '', `/invite/accept?ref=email#token=${TOKEN}`);

      expect(readAndStripInviteTokenFromHash()).toBe(TOKEN);
      expect(window.location.search).toBe('?ref=email');
    });

    it('strips a fragment that carried no token, and answers with none', () => {
      window.history.replaceState(null, '', '/invite/accept#something-else');

      expect(readAndStripInviteTokenFromHash()).toBeNull();
      expect(window.location.hash).toBe('');
    });

    it('answers with none when there is no fragment at all', () => {
      expect(readAndStripInviteTokenFromHash()).toBeNull();
    });

    it.each([
      { fragment: `token=${TOKEN}&signup=1`, expected: true },
      { fragment: `token=${TOKEN}`, expected: false },
    ])('reports a sign-up hint of $expected for #$fragment', ({ fragment, expected }) => {
      window.history.replaceState(null, '', `/invite/accept#${fragment}`);

      expect(readAndStripInviteTokenFromHash()).toBe(TOKEN);
      expect(hasSignUpHint()).toBe(expected);
    });

    it('keeps the sign-up hint once the fragment is gone', () => {
      window.history.replaceState(null, '', `/invite/accept#token=${TOKEN}&signup=1`);
      readAndStripInviteTokenFromHash();

      // `beforeLoad` runs again on first load and finds no fragment; it must
      // redirect to the same place the first run did.
      readAndStripInviteTokenFromHash();
      expect(hasSignUpHint()).toBe(true);
    });

    it('decodes a token the link had to escape', () => {
      window.history.replaceState(null, '', `/invite/accept#token=${encodeURIComponent('a+b/c=')}`);

      expect(readAndStripInviteTokenFromHash()).toBe('a+b/c=');
    });
  });

  describe('the stash', () => {
    it('reports a token waiting and hands it over exactly once', () => {
      cacheInviteToken(TOKEN);
      expect(hasPendingInviteToken()).toBe(true);

      expect(getCachedInviteToken()).toBe(TOKEN);
      // Storage is cleared on the way out, so nothing sends the app back here.
      expect(sessionStorage.getItem('filone:pendingInviteToken')).toBeNull();
      expect(hasPendingInviteToken()).toBe(false);
    });

    it('answers the same token when asked again in one page load', () => {
      cacheInviteToken(TOKEN);

      // The route takes it in `beforeLoad`; the component asks again on render.
      expect(getCachedInviteToken()).toBe(TOKEN);
      expect(getCachedInviteToken()).toBe(TOKEN);
    });

    it('clears storage again when a token taken earlier in the page load is stashed and taken again', () => {
      cacheInviteToken(TOKEN);
      getCachedInviteToken();

      // The accept page stashes again when it is refused for an unverified
      // email, then comes back to the route after `/verify-email` without a
      // reload. A token left in storage sends every later visit to the app
      // route straight back to the accept page.
      cacheInviteToken(TOKEN);
      expect(getCachedInviteToken()).toBe(TOKEN);
      expect(hasPendingInviteToken()).toBe(false);
    });

    it('has nothing to hand over when nothing was stashed', () => {
      expect(hasPendingInviteToken()).toBe(false);
      expect(getCachedInviteToken()).toBeNull();
    });

    it('keeps the token in memory when storage refuses it', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('storage disabled');
      });
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('storage disabled');
      });

      expect(() => cacheInviteToken(TOKEN)).not.toThrow();
      // Nothing is waiting for another document to pick up — memory does not
      // outlive this one — but the accept that needs no login round trip has
      // its token, which is the difference between the link working in this
      // browser and never working in it.
      expect(hasPendingInviteToken()).toBe(false);
      expect(getCachedInviteToken()).toBe(TOKEN);
    });

    it('answers with no token when storage is unavailable and nothing was stashed', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('storage disabled');
      });

      expect(getCachedInviteToken()).toBeNull();
    });
  });
});
