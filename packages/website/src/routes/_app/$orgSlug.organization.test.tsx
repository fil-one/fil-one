import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

// The route's parent is the whole app layout; the gate under test does not need
// it, and importing it would drag the router in.
vi.mock('./$orgSlug', () => ({ Route: {} }));

// The page itself is covered by OrganizationPage.test.tsx. Here it only has to
// be distinguishable from the two refusals.
vi.mock('../../pages/OrganizationPage', () => ({
  OrganizationPage: () => <div data-testid="organization-page" />,
}));

vi.mock('../../lib/api.js', () => ({ getMe: vi.fn() }));

import { OrganizationGate } from './$orgSlug.organization';
import { seedPermissions } from '../../lib/test-permissions.js';

const SOLO = [{ orgId: 'org-1', orgName: 'Acme', slug: 'acme', role: OrgRole.Owner }];
const TWO_ORGS = [
  { orgId: 'org-1', orgName: 'Acme', slug: 'acme', role: OrgRole.Owner },
  { orgId: 'org-2', orgName: 'Globex', slug: 'globex', role: OrgRole.Member },
];

function renderRoute(role: OrgRole, overrides: Partial<MeResponse>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role, overrides);
  return render(
    <QueryClientProvider client={client}>
      <OrganizationGate />
    </QueryClientProvider>,
  );
}

describe('the /organization route, reached by URL', () => {
  it('opens for a solo org in the beta', () => {
    renderRoute(OrgRole.Owner, { memberships: SOLO, orgsBeta: true });

    expect(screen.getByTestId('organization-page')).toBeTruthy();
  });

  it('opens for a caller in more than one org', () => {
    renderRoute(OrgRole.Member, { memberships: TWO_ORGS, orgsBeta: false });

    expect(screen.getByTestId('organization-page')).toBeTruthy();
  });

  it('says the feature is off for a solo org outside the beta', () => {
    // The gentler of the two refusals available: this caller holds
    // `members.read`, so the role denial would be a lie. The heading still
    // renders, so the URL does not land on a blank page.
    renderRoute(OrgRole.Owner, { memberships: SOLO, orgsBeta: false });

    expect(screen.getByTestId('members-not-enabled')).toBeTruthy();
    expect(screen.queryByTestId('organization-page')).toBeNull();
    expect(screen.queryByTestId('page-permission-denied')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Organization' })).toBeTruthy();
  });

  it('still refuses the role when the surface exists but the role cannot read it', () => {
    // The surface gate does not replace the permission — it precedes it.
    renderRoute(OrgRole.Owner, {
      memberships: TWO_ORGS,
      orgsBeta: true,
      permissions: [],
    });

    expect(screen.getByTestId('page-permission-denied')).toBeTruthy();
    expect(screen.queryByTestId('organization-page')).toBeNull();
  });

  it('renders the heading and nothing else while /me is in flight', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OrganizationGate />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Organization' })).toBeTruthy();
    expect(screen.queryByTestId('members-not-enabled')).toBeNull();
    expect(screen.queryByTestId('organization-page')).toBeNull();
  });
});
