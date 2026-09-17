import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { SidebarNav } from './SidebarNav';
import { seedPermissions } from '../lib/test-permissions.js';

// Render <a>/no-op router primitives so SidebarNav can mount without a router.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useMatchRoute: () => () => false,
}));

// Force both status banners to render so their button ids are present, and give
// the fixture the two memberships the org switcher needs to appear at all — with
// one, it renders nothing and a props regression stays invisible.
vi.mock('./use-sidebar-data.js', () => ({
  useSidebarData: () => ({
    me: {
      name: 'Ada',
      email: 'ada@example.com',
      orgName: 'Acme',
      orgId: '11111111-1111-1111-1111-111111111111',
      memberships: [
        { orgId: '11111111-1111-1111-1111-111111111111', orgName: 'Acme', role: 'owner' },
        { orgId: '22222222-2222-2222-2222-222222222222', orgName: 'Globex', role: 'member' },
      ],
    },
    displayName: 'Ada',
    initial: 'A',
    isTrialing: true,
    isPastDue: true,
    isInactive: true,
    trialDays: 5,
    trialEndsLabel: 'Expires soon',
    graceDays: 3,
    graceEndsLabel: 'Expires soon',
    storageUsed: 1,
    storagePct: 10,
    egressUsed: 1,
    egressPct: 10,
    // The trial meters need a denominator, which only a caller who can read
    // billing has.
    limitsKnown: true,
  }),
}));

vi.mock('./Tooltip.js', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./StatusIndicator.js', () => ({
  StatusIndicator: () => <div data-testid="status-indicator" />,
}));

vi.mock('../lib/api.js', () => ({ logout: vi.fn(), getMe: vi.fn() }));

// Mirrors how AppShell mounts the sidebar twice: the visible desktop sidebar
// plus the mobile drawer copy. The drawer copy must not duplicate the
// page-unique e2e selectors, or Playwright strict-mode locators break.
function renderBothSidebars(role: OrgRole = OrgRole.Owner, overrides: Partial<MeResponse> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The Billing entry is gated on `billing.view`, so the role has to be known
  // before the nav renders.
  seedPermissions(client, role, overrides);
  return render(
    <QueryClientProvider client={client}>
      <SidebarNav collapsed={false} onToggle={() => {}} showTestIds={true} />
      <SidebarNav
        collapsed={false}
        onToggle={() => {}}
        onClose={() => {}}
        showUserProfile={false}
        showTestIds={false}
      />
    </QueryClientProvider>,
  );
}

const UNIQUE_IDS = [
  'sidebar-upgrade-button',
  'sidebar-update-payment-button',
  'sidebar-choose-plan-button',
];
const UNIQUE_TESTIDS = [
  'nav-dashboard',
  'nav-buckets',
  'nav-api-keys',
  'nav-organization',
  'nav-settings',
  'user-profile',
];

/** One membership, which is what a solo org has. */
const SOLO = [{ orgId: 'org-1', orgName: 'Acme', role: OrgRole.Owner }];

/** Two, which is the other way to have a members surface. */
const TWO_ORGS = [
  { orgId: 'org-1', orgName: 'Acme', role: OrgRole.Owner },
  { orgId: 'org-2', orgName: 'Globex', role: OrgRole.Member },
];

describe('SidebarNav e2e selector uniqueness (desktop + drawer mounted)', () => {
  it.each(UNIQUE_IDS)('renders #%s exactly once', (id) => {
    const { container } = renderBothSidebars();
    expect(container.querySelectorAll(`#${id}`)).toHaveLength(1);
  });

  it.each(UNIQUE_TESTIDS)('renders [data-testid="%s"] exactly once', (testId) => {
    const { container } = renderBothSidebars();
    expect(container.querySelectorAll(`[data-testid="${testId}"]`)).toHaveLength(1);
  });

  it('renders #user-menu-logout-button exactly once after opening the menu', () => {
    const { container } = renderBothSidebars();
    // Only the desktop sidebar has a user-profile trigger; the drawer omits it.
    const triggers = container.querySelectorAll('[data-testid="user-profile"]');
    expect(triggers).toHaveLength(1);
    fireEvent.click(triggers[0]);
    expect(container.querySelectorAll('#user-menu-logout-button')).toHaveLength(1);
  });
});

describe('SidebarNav — the org switcher', () => {
  function openUserMenu() {
    const rendered = renderBothSidebars();
    fireEvent.click(rendered.container.querySelectorAll('[data-testid="user-profile"]')[0]);
    return rendered;
  }

  it('mounts in the user menu with the active org marked', () => {
    const { container } = openUserMenu();

    // The props are the mount point's to get right — `activeOrgId={me.userId}`
    // compiles and would leave every org unmarked.
    expect(container.querySelectorAll('[data-testid="org-switcher"]')).toHaveLength(1);
    const active = container.querySelector(`button[aria-current="true"]`);
    expect(active?.textContent).toBe('Acme');
  });

  it('offers the caller’s other org', () => {
    const { container } = openUserMenu();

    const names = [...container.querySelectorAll('[data-testid="org-switcher"] button')].map(
      (b) => b.textContent,
    );
    expect(names).toEqual(['Acme', 'Globex']);
  });
});

describe('SidebarNav — the Organization entry', () => {
  it.each([OrgRole.Owner, OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly])(
    'renders for %s, since every role holds members.read',
    (role) => {
      // Billing is a tab of that page now rather than an entry of its own, and
      // the tab gates itself on `billing.view`.
      const { container } = renderBothSidebars(role);

      expect(container.querySelectorAll('[data-testid="nav-organization"]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-testid="nav-billing"]')).toHaveLength(0);
    },
  );
});

describe('SidebarNav — the Members entry', () => {
  function membersEntries(role: OrgRole, overrides: Partial<MeResponse>) {
    // Both mounts at once: the entry is declared in one array, so a gate that
    // only reached the desktop copy would leave the drawer offering the link.
    const { container } = renderBothSidebars(role, overrides);
    return container.querySelectorAll('[data-testid="nav-organization"]');
  }

  it('renders for a solo org in the beta, so somebody can send the first invite', () => {
    expect(membersEntries(OrgRole.Owner, { memberships: SOLO, orgsBeta: true })).toHaveLength(1);
  });

  it('renders for a caller in more than one org, beta or not', () => {
    expect(membersEntries(OrgRole.Member, { memberships: TWO_ORGS, orgsBeta: false })).toHaveLength(
      1,
    );
  });

  it('renders when both conditions hold', () => {
    expect(membersEntries(OrgRole.Owner, { memberships: TWO_ORGS, orgsBeta: true })).toHaveLength(
      1,
    );
  });

  it('is absent for a solo org outside the beta, on both mounts', () => {
    // The whole point of the gate: an account that has never had a second
    // member sees no members surface anywhere, deploy or no deploy.
    expect(membersEntries(OrgRole.Owner, { memberships: SOLO, orgsBeta: false })).toHaveLength(0);
  });

  it('is absent while /me has not answered', () => {
    // Nothing seeded: the entry must not appear and then withdraw.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <SidebarNav collapsed={false} onToggle={() => {}} showTestIds={true} />
      </QueryClientProvider>,
    );

    expect(container.querySelectorAll('[data-testid="nav-organization"]')).toHaveLength(0);
  });

  it('leaves the other utility entries alone when it hides', () => {
    const { container } = renderBothSidebars(OrgRole.Owner, {
      memberships: SOLO,
      orgsBeta: false,
    });

    expect(container.querySelectorAll('[data-testid="nav-organization"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="nav-settings"]')).toHaveLength(1);
  });
});

describe('SidebarNav — the Billing entry', () => {
  // Billing is a tab of the Organization page, so it earns a top-level entry in
  // exactly the org that has no Organization page: a solo org outside the beta.
  // Both mounts at once, for the reason the Members entry checks both.
  function billingEntries(role: OrgRole, overrides: Partial<MeResponse>) {
    const { container } = renderBothSidebars(role, overrides);
    return container.querySelectorAll('[data-testid="nav-billing"]');
  }

  it('renders for a solo org outside the beta, which has no Organization page', () => {
    expect(billingEntries(OrgRole.Owner, { memberships: SOLO, orgsBeta: false })).toHaveLength(1);
  });

  it('is absent where the Organization page holds it as a tab', () => {
    expect(billingEntries(OrgRole.Owner, { memberships: SOLO, orgsBeta: true })).toHaveLength(0);
    expect(billingEntries(OrgRole.Owner, { memberships: TWO_ORGS, orgsBeta: false })).toHaveLength(
      0,
    );
  });

  // Never both: the two entries are one surface seen from two orgs, and a nav
  // offering Organization and Billing side by side would open the same cards
  // from two places.
  it('is never shown beside the Organization entry', () => {
    for (const overrides of [
      { memberships: SOLO, orgsBeta: false },
      { memberships: SOLO, orgsBeta: true },
      { memberships: TWO_ORGS, orgsBeta: true },
    ]) {
      const { container, unmount } = renderBothSidebars(OrgRole.Owner, overrides);
      const shown = ['nav-organization', 'nav-billing'].filter(
        (testId) => container.querySelectorAll(`[data-testid="${testId}"]`).length > 0,
      );
      expect(shown).toHaveLength(1);
      unmount();
    }
  });

  it('is absent for a role without billing.view, beta or not', () => {
    // The gate decides whether the entry exists; the permission still decides
    // who sees it. A Member holds no `billing.view` either way.
    expect(billingEntries(OrgRole.Member, { memberships: SOLO, orgsBeta: false })).toHaveLength(0);
  });

  it('is absent while /me has not answered', () => {
    // Neither side of the gate is known yet, so neither entry appears rather
    // than one showing and being swapped for the other.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <SidebarNav collapsed={false} onToggle={() => {}} showTestIds={true} />
      </QueryClientProvider>,
    );

    expect(container.querySelectorAll('[data-testid="nav-billing"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="nav-organization"]')).toHaveLength(0);
  });
});

describe('SidebarNav — the API Keys entry', () => {
  it.each([OrgRole.Owner, OrgRole.Admin, OrgRole.Member])(
    'renders for %s, who holds keys.manage_own',
    (role) => {
      const { container } = renderBothSidebars(role);

      expect(container.querySelectorAll('[data-testid="nav-api-keys"]')).toHaveLength(1);
    },
  );

  it('is absent for ReadOnly', () => {
    // ReadOnly holds no `keys.*`: the list request is refused, and the page has
    // nothing but the connection reference left.
    const { container } = renderBothSidebars(OrgRole.ReadOnly);

    expect(container.querySelectorAll('[data-testid="nav-api-keys"]')).toHaveLength(0);
    // Buckets carries no permission — every role browses.
    expect(container.querySelectorAll('[data-testid="nav-buckets"]')).toHaveLength(1);
  });
});

// Collapsed mode hides the display name and the avatar is decorative, so the
// button's own label is the only accessible name left.
describe('SidebarNav user profile accessible name', () => {
  it.each([true, false])('names the user-profile button when collapsed=%s', (collapsed) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedPermissions(client, OrgRole.Owner);
    const { getByTestId } = render(
      <QueryClientProvider client={client}>
        <SidebarNav collapsed={collapsed} onToggle={() => {}} showTestIds={true} />
      </QueryClientProvider>,
    );
    expect(getByTestId('user-profile')).toHaveAccessibleName('User menu for Ada');
  });
});
