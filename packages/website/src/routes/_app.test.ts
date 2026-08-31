import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isRedirect } from '@tanstack/react-router';

import { Route } from './_app.js';
import { stashInviteToken } from '../lib/invite-token.js';

/** `beforeLoad` is called by the router with a context bag this route ignores. */
function runBeforeLoad(): Promise<void> {
  return (Route.options.beforeLoad as () => Promise<void>)();
}

function setCookie(value: string) {
  Object.defineProperty(document, 'cookie', { value, writable: true, configurable: true });
}

describe('the app layout’s beforeLoad', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    setCookie('hs_logged_in=1');
  });

  it('sends a caller with a waiting invitation back to redeem it', async () => {
    // The login bounce lands every caller on `/dashboard` — there is no
    // `returnTo` in the auth flow — so this is the return trip for somebody who
    // was mid-acceptance when it happened.
    stashInviteToken('a'.repeat(32));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const thrown = await runBeforeLoad().catch((err: unknown) => err);

    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: { to?: string } }).options.to).toBe('/invite/accept');
    // Ahead of the `/me` read below it: the accept is what decides which org
    // `/me` should be answering about.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends a signed-out caller to login instead, however that stash got there', async () => {
    setCookie('');
    stashInviteToken('a'.repeat(32));

    const thrown = await runBeforeLoad().catch((err: unknown) => err);

    // The cookie check comes first, so the two redirects cannot take turns.
    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: { href?: string } }).options.href).toBe('/login');
  });
});
