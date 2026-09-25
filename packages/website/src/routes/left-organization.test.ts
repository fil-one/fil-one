import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isRedirect } from '@tanstack/react-router';
import type { MeResponse } from '@filone/shared';

import { Route } from './left-organization.js';
import { queryClient } from '../lib/query-client.js';

function runBeforeLoad(): Promise<void> {
  return (Route.options.beforeLoad as () => Promise<void>)();
}

function meWith(overrides: Partial<MeResponse>) {
  vi.spyOn(queryClient, 'fetchQuery').mockResolvedValue({
    orgId: 'org-1',
    orgName: 'Acme',
    emailVerified: true,
    email: 'user@example.com',
    mfaEnrollments: [],
    ...overrides,
  } as MeResponse);
}

// Only the owner of an unnamed floor org has anything to read here.
describe('/left-organization', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(document, 'cookie', {
      value: 'hs_logged_in=1',
      writable: true,
      configurable: true,
    });
  });

  it('shows for the owner of an unnamed floor org', async () => {
    meWith({ nameConfirmed: false, floorOrg: true });

    await expect(runBeforeLoad()).resolves.toBeUndefined();
  });

  it('sends a caller whose org is named on to its dashboard', async () => {
    meWith({ nameConfirmed: true, floorOrg: true });

    const thrown = await runBeforeLoad().catch((err: unknown) => err);

    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: { to?: string } }).options.to).toBe('/dashboard');
  });

  it('sends a new signup to the naming step it belongs on', async () => {
    meWith({ nameConfirmed: false });

    const thrown = await runBeforeLoad().catch((err: unknown) => err);

    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: { to?: string } }).options.to).toBe('/create-organization');
  });
});
