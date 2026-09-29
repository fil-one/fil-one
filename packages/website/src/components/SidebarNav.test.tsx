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
}));

// The org the menu reads from `/me`, with the two memberships the org switcher
// needs to appear at all.
const ORG_ME: Partial<MeResponse> = {
  orgName: 'Acme',
  orgId: '11111111-1111-1111-1111-111111111111',
  memberships: [
    {
      orgId: '11111111-1111-1111-1111-111111111111',
      orgName: 'Acme',
      role: OrgRole.Owner,
    },
    {
      orgId: '22222222-2222-2222-2222-222222222222',
      orgName: 'Globex',
      role: OrgRole.Member,
    },
  ],
};

// Force both status banners to render so their button ids are present.
vi.mock('./use-sidebar-data.js', () => ({
  useSidebarData: () => ({
    me: { name: 'Ada', email: 'ada@example.com' },
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
  seedPermissions(client, role, { ...ORG_ME, ...overrides });
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
function renderOneSidebar({
  overrides = {},
  collapsed = false,
}: { overrides?: Partial<MeResponse>; collapsed?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner, { ...ORG_ME, ...overrides });
  return render(
    <QueryClientProvider client={client}>
      <SidebarNav collapsed={collapsed} onToggle={() => {}} showTestIds={true} />
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
  'org-switcher-button',
  'user-menu-button',
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
  it('lists every org in the menu with the active one marked', () => {
    renderOneSidebar();
    fireEvent.click(screen.getByTestId('org-switcher-button'));

    // The panel is portalled, so `screen` rather than `container` finds it.
    const switcher = within(screen.getByTestId('org-switcher'));
    expect(switcher.getAllByRole('menuitem')).toEqual([
      switcher.getByRole('menuitem', { name: 'Acme', current: true }),
      switcher.getByRole('menuitem', { name: 'Globex', current: false }),
    ]);
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

// Collapsed mode hides the display names and the avatars are decorative, so
// each button's own label is the only accessible name left.
describe('SidebarNav identity accessible names', () => {
  it.each([true, false])('names the user and org menu buttons when collapsed=%s', (collapsed) => {
    renderOneSidebar({ collapsed });

    expect(screen.getByTestId('user-menu-button')).toHaveAccessibleName('User menu for Ada');
    expect(screen.getByTestId('org-switcher-button')).toHaveAccessibleName(
      'Organization menu for Acme',
    );
  });
});
