import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isRedirect } from '@tanstack/react-router';

import type { MeResponse } from '@filone/shared';

import { Route } from './_app.js';
import { stashInviteToken } from '../lib/invite-token.js';
import { queryClient } from '../lib/query-client.js';

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

  // Every account has an unnamed personal org from signup, including one that
  // joined by invitation and only works in the team org.
  describe('an unnamed org', () => {
    function meWith(memberships: string[]) {
      vi.spyOn(queryClient, 'fetchQuery').mockResolvedValue({
        orgId: 'personal',
        orgName: 'Personal',
        nameConfirmed: false,
        emailVerified: true,
        email: 'user@example.com',
        mfaEnrollments: [],
        memberships: memberships.map((orgId) => ({ orgId, orgName: orgId, role: 'owner' })),
      } as unknown as MeResponse);
    }

    async function redirectTarget() {
      const thrown = await runBeforeLoad().catch((err: unknown) => err);
      return isRedirect(thrown) ? (thrown as { options: { to?: string } }).options.to : undefined;
    }

    it('sends a brand-new account, with nowhere else to be, to name it', async () => {
      meWith(['personal']);

      expect(await redirectTarget()).toBe('/create-organization');
    });

    // A fresh tab resolves to the personal org; asking there would stop an
    // invitee on every new tab to name an org they never asked for.
    it('lets an account that belongs to another org through', async () => {
      meWith(['personal', 'team']);

      expect(await redirectTarget()).toBeUndefined();
    });
  });

  describe('an unnamed org', () => {
    function meWith(overrides: Partial<MeResponse>) {
      vi.spyOn(queryClient, 'fetchQuery').mockResolvedValue({
        orgId: 'org-1',
        orgName: 'Acme',
        emailVerified: true,
        email: 'user@example.com',
        mfaEnrollments: [],
        nameConfirmed: false,
        ...overrides,
      } as MeResponse);
    }

    it('sends a new signup to name it', async () => {
      meWith({});

      const thrown = await runBeforeLoad().catch((err: unknown) => err);

      expect((thrown as { options: { to?: string } }).options.to).toBe('/create-organization');
    });

    // A floor org's owner is not new: they lost their last membership, and are
    // told so before they are asked to name anything.
    it('sends the owner of a floor org to /left-organization instead', async () => {
      meWith({ floorOrg: true });

      const thrown = await runBeforeLoad().catch((err: unknown) => err);

      expect((thrown as { options: { to?: string } }).options.to).toBe('/left-organization');
    });
  });
});
