import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isRedirect } from '@tanstack/react-router';

import { Route } from './invite.accept.js';
import {
  hasPendingInviteToken,
  resetTakenInviteToken,
  getCachedInviteToken,
} from '../lib/invite-token.js';

const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** `beforeLoad` is called by the router with a context bag this route ignores. */
function runBeforeLoad() {
  return (Route.options.beforeLoad as () => void)();
}

/** Where `beforeLoad` redirected to; fails the test when it did not redirect. */
function redirectHref(): string | undefined {
  try {
    runBeforeLoad();
  } catch (thrown) {
    expect(isRedirect(thrown)).toBe(true);
    return (thrown as Response & { options: { href?: string } }).options.href;
  }
  return expect.unreachable('beforeLoad should have redirected');
}

function setCookie(value: string) {
  Object.defineProperty(document, 'cookie', { value, writable: true, configurable: true });
}

describe('the accept route’s beforeLoad', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetTakenInviteToken();
    window.history.replaceState(null, '', `/invite/accept#token=${TOKEN}`);
    setCookie('hs_logged_in=1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes the token out of the URL and hands it to the page', () => {
    runBeforeLoad();

    expect(window.location.hash).toBe('');
    expect(getCachedInviteToken()).toBe(TOKEN);
  });

  it('strips the fragment before anything could have called the API', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    runBeforeLoad();

    // What this pins is the ordering, which is the security property: the strip
    // has happened by the time `beforeLoad` returns, and the accept call is
    // fired on render, after it. So no request can go out while the token is
    // still in a URL an error reporter would capture.
    expect(replaceState).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the token across the login bounce for a signed-out caller', () => {
    setCookie('');

    // No `returnTo` in the auth flow, so the token has to outlive the redirect.
    expect(() => runBeforeLoad()).toThrow();
    expect(hasPendingInviteToken()).toBe(true);
    expect(window.location.hash).toBe('');
  });

  it.each([
    { link: `#token=${TOKEN}`, href: '/login' },
    { link: `#token=${TOKEN}&signup=1`, href: '/login?screen_hint=signup' },
  ])('sends a signed-out caller from $link to $href', ({ link, href }) => {
    window.history.replaceState(null, '', `/invite/accept${link}`);
    setCookie('');

    expect(redirectHref()).toBe(href);
  });

  it('sends a signed-out caller to sign-up on the second run too, when the fragment is gone', () => {
    window.history.replaceState(null, '', `/invite/accept#token=${TOKEN}&signup=1`);
    setCookie('');
    redirectHref();

    expect(redirectHref()).toBe('/login?screen_hint=signup');
  });

  it('lets a signed-in caller through whatever the link hints', () => {
    window.history.replaceState(null, '', `/invite/accept#token=${TOKEN}&signup=1`);

    expect(() => runBeforeLoad()).not.toThrow();
  });

  it('leaves storage clear once the token has been taken', () => {
    runBeforeLoad();

    // A page that then failed to render must not leave the app bouncing back
    // here forever, so the stash is emptied here rather than on render.
    expect(hasPendingInviteToken()).toBe(false);
  });

  it('answers with no token when the link carried none', () => {
    window.history.replaceState(null, '', '/invite/accept');

    runBeforeLoad();

    expect(getCachedInviteToken()).toBeNull();
  });
});
