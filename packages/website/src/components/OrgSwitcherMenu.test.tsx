import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import type { OrgMembershipSummary } from '@filone/shared';

import { OrgSwitcherMenu } from './OrgSwitcherMenu';
import { seedPermissions } from '../lib/test-permissions.js';

// `BaseLink` renders through `@tanstack/react-router`'s `Link`, which throws
// outside a mounted router; these cases are about the menu's own contents,
// not routing, so a plain anchor stands in — same stand-in `SidebarNav.test.tsx`
// uses for the same reason.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useParams: () => ({}),
}));

// `usePermissions` reads `/me` through this; the cache is seeded directly so
// the real hook (and its fail-closed reads) stays in the test.
vi.mock('../lib/api.js', () => ({ getMe: vi.fn() }));

const switchToOrg = vi.fn();
vi.mock('../lib/active-org.js', () => ({
  switchToOrg: (...args: unknown[]) => switchToOrg(...args),
  onSwitchingOrgChange: () => () => {},
}));

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const memberships: OrgMembershipSummary[] = [
  { orgId: ORG_A, orgName: 'Acme', slug: 'acme', role: OrgRole.Owner },
  { orgId: ORG_B, orgName: 'Globex', slug: 'globex', role: OrgRole.Member },
];

function renderMenu(overrides: Partial<React.ComponentProps<typeof OrgSwitcherMenu>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner);
  return render(
    <QueryClientProvider client={client}>
      <OrgSwitcherMenu
        orgName="Acme"
        logoUrl={undefined}
        memberships={memberships}
        activeOrgId={ORG_A}
        collapsed={false}
        testId="org-switcher-button"
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

describe('OrgSwitcherMenu', () => {
  it('is closed until the trigger is clicked', () => {
    renderMenu();

    // Headless UI's `MenuItems` panel is portalled to `document.body`, so
    // `screen` is what would find it, not a scoped query — and it should not
    // be there before the trigger is clicked.
    expect(screen.queryByText('Members')).not.toBeInTheDocument();
  });

  it('opens the menu on click', () => {
    renderMenu();

    fireEvent.click(screen.getByTestId('org-switcher-button'));

    expect(screen.getByText('Edit organization')).toBeInTheDocument();
    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(screen.getByText('Billing')).toBeInTheDocument();
  });

  it('lists the memberships passed in', () => {
    renderMenu();

    fireEvent.click(screen.getByTestId('org-switcher-button'));

    const switcher = screen.getByTestId('org-switcher');
    expect(within(switcher).getByText('Acme')).toBeInTheDocument();
    expect(within(switcher).getByText('Globex')).toBeInTheDocument();
  });

  it('switches organization when another org is chosen', () => {
    renderMenu();

    fireEvent.click(screen.getByTestId('org-switcher-button'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Globex' }));

    expect(switchToOrg).toHaveBeenCalledWith(ORG_B);
  });

  it('opens the create-organization dialog from its own action', () => {
    renderMenu();

    fireEvent.click(screen.getByTestId('org-switcher-button'));
    fireEvent.click(screen.getByText('Create organization'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
