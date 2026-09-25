import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { SidebarNav } from './SidebarNav';
import { ToastProvider } from './Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { queryKeys } from '../lib/query-client.js';

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
      <ToastProvider>
        <SidebarNav collapsed={false} showTestIds={true} />
        <SidebarNav
          collapsed={false}
          onClose={() => {}}
          showUserProfile={false}
          showTestIds={false}
        />
      </ToastProvider>
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
  pendingOrgName,
}: { overrides?: Partial<MeResponse>; collapsed?: boolean; pendingOrgName?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner, { ...ORG_ME, ...overrides });
  if (pendingOrgName) {
    client.setQueryData(queryKeys.pendingOrgSwitch, {
      orgId: '22222222-2222-2222-2222-222222222222',
      orgName: pendingOrgName,
    });
  }
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <SidebarNav collapsed={collapsed} showTestIds={true} />
      </ToastProvider>
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

describe('SidebarNav footer', () => {
  // On desktop, bug report and system status live in the utility bar under the
  // content window; only the drawer, which has no such bar, carries them.
  it('carries bug report and system status in the drawer copy only', () => {
    const { container } = renderBothSidebars();
    const [desktop, drawer] = container.querySelectorAll('nav');

    expect(within(desktop).queryByTestId('status-indicator')).not.toBeInTheDocument();
    expect(within(desktop).queryByRole('button', { name: 'Report a bug' })).not.toBeInTheDocument();
    expect(within(drawer).getByTestId('status-indicator')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Report a bug' })).toBeInTheDocument();
  });

  it('opens the bug-report dialog from the drawer', async () => {
    const { container } = renderBothSidebars();
    const drawer = container.querySelectorAll('nav')[1];

    fireEvent.click(within(drawer).getByRole('button', { name: 'Report a bug' }));
    expect(await screen.findByTestId('report-bug-dialog')).toBeInTheDocument();
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

// `switchToOrg` clears the cache, so `/me` has no org name until it answers.
describe('SidebarNav — the pending org switch target', () => {
  it('names the org being switched to instead of the "Organization" placeholder', () => {
    renderOneSidebar({ overrides: { orgName: undefined }, pendingOrgName: 'Globex' });

    expect(screen.getByTestId('org-switcher-button')).toHaveAccessibleName(
      'Organization menu for Globex',
    );
  });

  it('falls back to the placeholder when no switch is pending either', () => {
    renderOneSidebar({ overrides: { orgName: undefined } });

    expect(screen.getByTestId('org-switcher-button')).toHaveAccessibleName(
      'Organization menu for Organization',
    );
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
