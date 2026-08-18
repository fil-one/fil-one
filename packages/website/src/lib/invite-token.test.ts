import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  hasPendingInviteToken,
  readAndStripInviteTokenFromHash,
  resetTakenInviteToken,
  stashInviteToken,
  takeInviteToken,
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

    it('decodes a token the link had to escape', () => {
      window.history.replaceState(null, '', `/invite/accept#token=${encodeURIComponent('a+b/c=')}`);

      expect(readAndStripInviteTokenFromHash()).toBe('a+b/c=');
    });
  });

  describe('the stash', () => {
    it('reports a token waiting and hands it over exactly once', () => {
      stashInviteToken(TOKEN);
      expect(hasPendingInviteToken()).toBe(true);

      expect(takeInviteToken()).toBe(TOKEN);
      // Storage is cleared on the way out, so nothing sends the app back here.
      expect(sessionStorage.getItem('filone:pendingInviteToken')).toBeNull();
      expect(hasPendingInviteToken()).toBe(false);
    });

    it('answers the same token when asked again in one page load', () => {
      stashInviteToken(TOKEN);

      // The route takes it in `beforeLoad`; the component asks again on render.
      expect(takeInviteToken()).toBe(TOKEN);
      expect(takeInviteToken()).toBe(TOKEN);
    });

    it('has nothing to hand over when nothing was stashed', () => {
      expect(hasPendingInviteToken()).toBe(false);
      expect(takeInviteToken()).toBeNull();
    });

    it('survives storage being unavailable', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('storage disabled');
      });
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('storage disabled');
      });

      expect(() => stashInviteToken(TOKEN)).not.toThrow();
      expect(hasPendingInviteToken()).toBe(false);
      expect(takeInviteToken()).toBeNull();
    });
  });
});
