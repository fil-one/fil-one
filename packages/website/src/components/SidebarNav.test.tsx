import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen, within } from '@testing-library/react';
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
  // `useOrgPath` reads the active org's slug through this; no org context
  // here, so nav links render with their unprefixed paths.
  useParams: () => ({}),
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
        {
          orgId: '11111111-1111-1111-1111-111111111111',
          orgName: 'Acme',
          slug: 'acme',
          role: 'owner',
        },
        {
          orgId: '22222222-2222-2222-2222-222222222222',
          orgName: 'Globex',
          slug: 'globex',
          role: 'member',
        },
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

// A single mount, for cases that open a menu and inspect its contents. The
// second (mobile drawer) copy `renderBothSidebars` also mounts is irrelevant
// to these — its own `showUserProfile={false}` means it has no org switcher
// or user menu of its own — and Headless UI's anchored `MenuItems` (used by
// both) is measurably slower to commit when a second unrelated subtree is
// mounted alongside it, which these tests otherwise have no reason to wait on.
function renderOneSidebar(role = OrgRole.Owner, overrides: Partial<MeResponse> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role, overrides);
  return render(
    <QueryClientProvider client={client}>
      <SidebarNav collapsed={false} onToggle={() => {}} showTestIds={true} />
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
  'org-switcher-button',
  'user-menu-button',
];

/** One membership, which is what a solo org has. */
const SOLO = [{ orgId: 'org-1', orgName: 'Acme', slug: 'acme', role: OrgRole.Owner }];

/** Two, which is the other way to have a members surface. */
const TWO_ORGS = [
  { orgId: 'org-1', orgName: 'Acme', slug: 'acme', role: OrgRole.Owner },
  { orgId: 'org-2', orgName: 'Globex', slug: 'globex', role: OrgRole.Member },
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

  it('renders #user-menu-logout-button once the menu is opened', () => {
    // Single mount: see `renderOneSidebar`'s comment.
    const { getByTestId } = renderOneSidebar();
    fireEvent.click(getByTestId('user-menu-button'));
    // Headless UI's anchored `MenuItems` (floating-ui positioning) portals its
    // panel to `document.body` rather than rendering it inside RTL's own
    // `container` — `screen`, which queries the whole document, is what finds
    // it; `container.querySelectorAll` never will, open or not.
    expect(screen.getAllByText('Log out')).toHaveLength(1);
  });
});

describe('SidebarNav — the org switcher', () => {
  function openOrgSwitcher() {
    const rendered = renderOneSidebar();
    fireEvent.click(rendered.getByTestId('org-switcher-button'));
    return rendered;
  }

  it('mounts in the org switcher menu with the active org marked', () => {
    openOrgSwitcher();

    // The props are the mount point's to get right — `activeOrgId={me.userId}`
    // compiles and would leave every org unmarked. Queried via `screen`: see
    // the comment on the user-menu test above — the panel is portalled.
    expect(screen.getAllByTestId('org-switcher')).toHaveLength(1);
    // `inMenu` marks the active row with `aria-checked`, not `aria-current` —
    // see `OrgSwitcher`'s own comment on the two mount shapes.
    const active = screen.getByTestId('org-switcher').querySelector(`[aria-checked="true"]`);
    expect(active?.textContent).toBe('Acme');
  });

  it('offers the caller’s other org', () => {
    openOrgSwitcher();

    // `inMenu` (this mount point) gives each row `role="menuitemradio"`
    // rather than a plain button role — see `OrgSwitcher`'s own comment.
    const names = within(screen.getByTestId('org-switcher'))
      .getAllByRole('menuitemradio')
      .map((b) => b.textContent);
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
    // Billing is the other side of the same gate — a solo org outside the beta
    // has no Organization page, so Billing is the top-level entry left.
    expect(container.querySelectorAll('[data-testid="nav-billing"]')).toHaveLength(1);
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
describe('SidebarNav user identity accessible names', () => {
  it.each([true, false])('names the user menu button when collapsed=%s', (collapsed) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedPermissions(client, OrgRole.Owner);
    const { getByTestId } = render(
      <QueryClientProvider client={client}>
        <SidebarNav collapsed={collapsed} onToggle={() => {}} showTestIds={true} />
      </QueryClientProvider>,
    );
    expect(getByTestId('user-menu-button')).toHaveAccessibleName('User menu for Ada');
  });

  it.each([true, false])('names the org switcher button when collapsed=%s', (collapsed) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedPermissions(client, OrgRole.Owner);
    const { getByTestId } = render(
      <QueryClientProvider client={client}>
        <SidebarNav collapsed={collapsed} onToggle={() => {}} showTestIds={true} />
      </QueryClientProvider>,
    );
    expect(getByTestId('org-switcher-button')).toHaveAccessibleName(
      'Switch organization, current: Acme',
    );
  });
});
