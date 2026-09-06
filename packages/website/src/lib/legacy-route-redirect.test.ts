import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoute, createRootRoute, isRedirect, isNotFound } from '@tanstack/react-router';
import { OrgRole } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

vi.mock('./api.js', () => ({ getMe: vi.fn() }));

import { redirectToActiveOrgPath, legacyRedirectRoute } from './legacy-route-redirect.js';
import { getMe } from './api.js';
import { queryClient } from './query-client.js';

function me(memberships: MeResponse['memberships']): MeResponse {
  return { orgId: 'org-1', memberships } as unknown as MeResponse;
}

describe('redirectToActiveOrgPath', () => {
  beforeEach(() => {
    queryClient.clear();
    vi.mocked(getMe).mockReset();
  });

  it('redirects to the active org’s slug, replacing the entry', async () => {
    vi.mocked(getMe).mockResolvedValue(
      me([{ orgId: 'org-1', orgName: 'Acme', role: OrgRole.Owner, slug: 'acme' }]),
    );

    const thrown = await redirectToActiveOrgPath('/buckets/my-bucket').catch((err: unknown) => err);

    expect(isRedirect(thrown)).toBe(true);
    const { href, replace } = (thrown as { options: { href?: string; replace?: boolean } }).options;
    expect({ href, replace }).toEqual({ href: '/acme/buckets/my-bucket', replace: true });
  });

  it('is a not-found when there is no active org with a slug yet', async () => {
    vi.mocked(getMe).mockResolvedValue(me([]));

    const thrown = await redirectToActiveOrgPath('/dashboard').catch((err: unknown) => err);

    expect(isNotFound(thrown)).toBe(true);
  });
});

describe('legacyRedirectRoute', () => {
  const rootRoute = createRootRoute();
  const parentRoute = createRoute({ getParentRoute: () => rootRoute, id: 'parent' });

  beforeEach(() => {
    queryClient.clear();
    vi.mocked(getMe).mockReset();
  });

  it('carries the full incoming location through by default', async () => {
    vi.mocked(getMe).mockResolvedValue(
      me([{ orgId: 'org-1', orgName: 'Acme', role: OrgRole.Owner, slug: 'acme' }]),
    );
    const route = legacyRedirectRoute({ path: '/buckets', getParentRoute: () => parentRoute });

    const thrown = await (
      route.options.beforeLoad as (ctx: { location: { href: string } }) => Promise<void>
    )({ location: { href: '/buckets?region=us-east-1' } }).catch((err: unknown) => err);

    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: { href?: string } }).options.href).toBe(
      '/acme/buckets?region=us-east-1',
    );
  });

  it('redirects to a fixed target when one is given, ignoring the incoming location', async () => {
    vi.mocked(getMe).mockResolvedValue(
      me([{ orgId: 'org-1', orgName: 'Acme', role: OrgRole.Owner, slug: 'acme' }]),
    );
    const route = legacyRedirectRoute({
      path: '/organization',
      getParentRoute: () => parentRoute,
      target: '/edit-organization',
    });

    const thrown = await (
      route.options.beforeLoad as (ctx: { location: { href: string } }) => Promise<void>
    )({ location: { href: '/organization?tab=billing' } }).catch((err: unknown) => err);

    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: { href?: string } }).options.href).toBe('/acme/edit-organization');
  });

  it('tags the route so a route-tree check can tell it apart from a real page', () => {
    const route = legacyRedirectRoute({ path: '/support', getParentRoute: () => parentRoute });

    expect(route.options.staticData).toEqual({ legacyRedirect: true });
  });
});
