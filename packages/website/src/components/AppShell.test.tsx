import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { AppShell, gracePeriodMessage } from './AppShell';

/** What `/me` answers, per test. Undefined is the shell before it has replied. */
const fixtures = vi.hoisted(() => ({ me: undefined as unknown }));

vi.mock('./SidebarNav', () => ({
  SidebarNav: ({ onClose }: { onClose?: () => void }) => (
    <nav data-testid="sidebar-nav">
      <a href="/dashboard" onClick={onClose}>
        Dashboard
      </a>
    </nav>
  ),
}));

// The org menu's dialogs and links need a query client and a router; what is
// under test here is only where the menu mounts and what it lists.
// A switch navigates through the router; only that it starts matters here.
vi.mock('../router.js', () => ({ router: { navigate: vi.fn(async () => {}) } }));
vi.mock('./CreateOrganizationDialog.js', () => ({ CreateOrganizationDialog: () => null }));
vi.mock('./BaseLink.js', () => ({
  BaseLink: ({ href, ...props }: { href: string } & React.ComponentProps<'a'>) => (
    <a href={href} {...props} />
  ),
}));

vi.mock('./Banner', () => ({
  Banner: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// The content window's bottom-bar controls are covered on their own; here they
// are stubbed like the sidebar, so the shell's drawer/scroll/focus behaviour is
// tested without their toast and query dependencies.
vi.mock('./ReportBugButton', () => ({
  ReportBugButton: ({ variant }: { variant: string }) => (
    <button type="button" data-testid={`report-bug-${variant}`}>
      Report a bug
    </button>
  ),
}));

vi.mock('./StatusIndicator', () => ({
  StatusIndicator: ({ variant }: { variant: string }) => (
    <div data-testid={`status-indicator-${variant}`} />
  ),
}));

vi.mock('../lib/api', () => ({
  getUsage: vi.fn(),
  getBilling: vi.fn(),
  getMe: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../lib/query-client.js', () => ({
  queryKeys: {
    usage: ['usage'],
    billing: ['billing'],
    me: ['me'],
    pendingOrgSwitch: ['pendingOrgSwitch'],
  },
  USAGE_STALE_TIME: 5 * 60_000,
  // The shell now reads `billing.view` before fetching billing, and the
  // permission hook is a third `/me` reader with its own staleTime.
  ME_STALE_TIME: 10 * 60_000,
  // A switch clears the cache, and seeds the destination's name, before it
  // navigates.
  queryClient: { clear: vi.fn(), setQueryData: vi.fn() },
}));

vi.mock(import('../lib/time.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  daysUntil: vi.fn(() => 5),
  formatDateTime: vi.fn(() => '2026-06-30'),
}));

vi.mock('@filone/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@filone/shared')>()),
  SubscriptionStatus: { GracePeriod: 'grace_period', Active: 'active', Trialing: 'trialing' },
  getUsageLimits: vi.fn(() => ({ storageLimitBytes: 1e12, egressLimitBytes: 2e12 })),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(({ queryKey }: { queryKey: readonly unknown[] }) =>
    queryKey[0] === 'me' ? { data: fixtures.me } : { data: undefined },
  ),
}));

function renderAppShell() {
  return render(<AppShell>page content</AppShell>);
}

function getHamburger() {
  return screen.getByRole('button', { name: 'Open navigation menu' });
}

function getCloseButton() {
  return screen.getByRole('button', { name: 'Close' });
}

function getDrawer() {
  return screen.getByRole('dialog');
}

describe('AppShell mobile drawer', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  });

  it('renders the mobile top bar with hamburger button', () => {
    renderAppShell();
    expect(getHamburger()).toBeInTheDocument();
  });

  it('renders the drawer closed initially', () => {
    renderAppShell();
    const drawer = getDrawer();
    expect(drawer.className).toContain('translate-x-full');
    expect(drawer.className).not.toContain('translate-x-0');
  });

  it('opens drawer when hamburger is clicked', () => {
    renderAppShell();
    fireEvent.click(getHamburger());
    const drawer = getDrawer();
    expect(drawer.className).toContain('translate-x-0');
    expect(drawer.className).not.toContain('translate-x-full');
  });

  it('sets aria-expanded on hamburger when drawer is open', () => {
    renderAppShell();
    const btn = getHamburger();
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('links hamburger to drawer via aria-controls', () => {
    renderAppShell();
    const btn = getHamburger();
    const drawerId = btn.getAttribute('aria-controls');
    expect(drawerId).toBeTruthy();
    expect(document.getElementById(drawerId!)).toBe(getDrawer());
  });

  it('closes drawer when X button is clicked', () => {
    renderAppShell();
    fireEvent.click(getHamburger());
    fireEvent.click(getCloseButton());
    expect(getDrawer().className).toContain('translate-x-full');
  });

  it('closes drawer when backdrop is clicked', () => {
    renderAppShell();
    fireEvent.click(getHamburger());
    const backdrop = screen.getByTestId('drawer-backdrop');
    fireEvent.click(backdrop);
    expect(getDrawer().className).toContain('translate-x-full');
  });

  it('closes drawer on Escape key', () => {
    renderAppShell();
    fireEvent.click(getHamburger());
    // From inside the drawer, where opening it puts focus.
    fireEvent.keyDown(getDrawer(), { key: 'Escape' });
    expect(getDrawer().className).toContain('translate-x-full');
  });

  // The bug-report dialog opened from the drawer is portalled out of it, and
  // Headless UI handles its Escape on `window`, after the drawer's listener.
  it('stays open when Escape comes from a dialog opened above it', () => {
    renderAppShell();
    fireEvent.click(getHamburger());
    const dialog = document.createElement('div');
    document.body.appendChild(dialog);

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(getDrawer().className).toContain('translate-x-0');
    dialog.remove();
  });

  it('does not close drawer on other keys', () => {
    renderAppShell();
    fireEvent.click(getHamburger());
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(getDrawer().className).toContain('translate-x-0');
  });

  it('closes drawer when a nav link inside the drawer is clicked', () => {
    renderAppShell();
    fireEvent.click(getHamburger());
    const drawerLink = getDrawer().querySelector('a[href="/dashboard"]') as HTMLElement;
    fireEvent.click(drawerLink);
    expect(getDrawer().className).toContain('translate-x-full');
  });
});

describe('AppShell body scroll lock', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  });

  it('locks body scroll when drawer opens', () => {
    renderAppShell();
    fireEvent.click(getHamburger());
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores body scroll when drawer closes', () => {
    renderAppShell();
    fireEvent.click(getHamburger());
    fireEvent.click(getCloseButton());
    expect(document.body.style.overflow).toBe('');
  });

  it('resets padding-right when drawer closes', () => {
    renderAppShell();
    fireEvent.click(getHamburger());
    fireEvent.click(getCloseButton());
    expect(document.body.style.paddingRight).toBe('');
  });

  it('restores body scroll on unmount', () => {
    const { unmount } = renderAppShell();
    fireEvent.click(getHamburger());
    unmount();
    expect(document.body.style.overflow).toBe('');
    expect(document.body.style.paddingRight).toBe('');
  });
});

describe('AppShell focus management', () => {
  it('moves focus to close button when drawer opens', async () => {
    renderAppShell();
    await act(async () => {
      fireEvent.click(getHamburger());
    });
    expect(document.activeElement).toBe(getCloseButton());
  });

  it('returns focus to hamburger when drawer closes via X button', async () => {
    renderAppShell();
    const hamburger = getHamburger();
    await act(async () => {
      fireEvent.click(hamburger);
    });
    await act(async () => {
      fireEvent.click(getCloseButton());
    });
    expect(document.activeElement).toBe(hamburger);
  });

  it('returns focus to hamburger when drawer closes via Escape', async () => {
    renderAppShell();
    const hamburger = getHamburger();
    await act(async () => {
      fireEvent.click(hamburger);
    });
    await act(async () => {
      fireEvent.keyDown(getDrawer(), { key: 'Escape' });
    });
    expect(document.activeElement).toBe(hamburger);
  });

  it('wraps focus from last to first element on Tab', async () => {
    renderAppShell();
    await act(async () => {
      fireEvent.click(getHamburger());
    });
    const drawerLink = getDrawer().querySelector('a[href="/dashboard"]') as HTMLElement;
    drawerLink.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    // The org menu leads the drawer header, ahead of close, in reading order.
    expect(document.activeElement).toBe(screen.getByTestId('mobile-org-switcher-button'));
  });

  it('wraps focus from first to last element on Shift+Tab', async () => {
    renderAppShell();
    await act(async () => {
      fireEvent.click(getHamburger());
    });
    screen.getByTestId('mobile-org-switcher-button').focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    const drawerLink = getDrawer().querySelector('a[href="/dashboard"]') as HTMLElement;
    expect(document.activeElement).toBe(drawerLink);
  });
});

describe('AppShell drawer accessibility', () => {
  it('drawer has role=dialog and aria-modal', () => {
    renderAppShell();
    const drawer = getDrawer();
    expect(drawer).toHaveAttribute('role', 'dialog');
    expect(drawer).toHaveAttribute('aria-modal', 'true');
  });

  it('drawer is inert when closed', () => {
    renderAppShell();
    expect(getDrawer()).toHaveAttribute('inert');
  });

  it('drawer is not inert when open', () => {
    renderAppShell();
    fireEvent.click(getHamburger());
    expect(getDrawer()).not.toHaveAttribute('inert');
  });

  it('renders desktop sidebar and drawer sidebars', () => {
    renderAppShell();
    expect(screen.getAllByTestId('sidebar-nav')).toHaveLength(2);
  });

  it('renders page content', () => {
    renderAppShell();
    expect(screen.getByText('page content')).toBeInTheDocument();
  });
});

describe('AppShell utility bar', () => {
  it('carries the icon bug report and the status pill', () => {
    renderAppShell();
    expect(screen.getByTestId('report-bug-icon')).toBeInTheDocument();
    expect(screen.getByTestId('status-indicator-pill')).toBeInTheDocument();
  });

  it('collapses and expands the desktop sidebar', () => {
    renderAppShell();
    const sidebar = screen.getAllByTestId('sidebar-nav')[0].parentElement!;
    expect(sidebar.className).toContain('w-60');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(sidebar.className).toContain('w-20');

    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(sidebar.className).toContain('w-60');
  });
});

describe('gracePeriodMessage', () => {
  it('pluralizes the countdown', () => {
    expect(gracePeriodMessage(5)).toBe(
      'Your free trial has expired. 5 days left to upgrade or download your data.',
    );
  });

  it('uses the singular unit on the second-to-last day', () => {
    expect(gracePeriodMessage(1)).toBe(
      'Your free trial has expired. 1 day left to upgrade or download your data.',
    );
  });

  it('warns that the account is disabled today when the countdown reaches zero', () => {
    expect(gracePeriodMessage(0)).toBe(
      "Your free trial has expired, and your account will be disabled later today. Upgrade to keep access or download your data before it's removed.",
    );
  });

  it('falls back to a complete sentence when the deadline is unknown', () => {
    expect(gracePeriodMessage(null)).toBe(
      "Your free trial has expired. Upgrade to keep access, or download your data before it's removed.",
    );
  });
});

describe('AppShell mobile user menu', () => {
  const ORG_A = '11111111-1111-1111-1111-111111111111';
  const ORG_B = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    // Only `/me` answers; usage and billing stay undefined, as they are for a
    // caller who cannot read them.
    fixtures.me = {
      name: 'Ada',
      orgId: ORG_A,
      orgName: 'Acme',
      memberships: [
        { orgId: ORG_A, orgName: 'Acme', role: 'owner' },
        { orgId: ORG_B, orgName: 'Globex', role: 'member' },
      ],
    };
  });

  afterEach(() => {
    fixtures.me = undefined;
  });

  function openUserMenu() {
    const rendered = render(<AppShell>page content</AppShell>);
    fireEvent.click(screen.getByRole('button', { name: 'User menu for Ada' }));
    return rendered;
  }

  it('offers the org menu in the mobile drawer with the active org checked', async () => {
    render(<AppShell>page content</AppShell>);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    fireEvent.click(await screen.findByTestId('mobile-org-switcher-button'));

    expect(await screen.findByRole('menuitem', { name: 'Acme' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: 'Globex' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('menuitem', { name: 'Create organization' })).toBeInTheDocument();
  });

  // Route params changing does not remount the shell, so a drawer left open
  // would cover the org the user just switched into.
  it('closes the mobile drawer when an org switch starts', async () => {
    render(<AppShell>page content</AppShell>);
    const hamburger = screen.getByRole('button', { name: 'Open navigation menu' });
    fireEvent.click(hamburger);
    fireEvent.click(await screen.findByTestId('mobile-org-switcher-button'));

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Globex' }));

    await waitFor(() => expect(hamburger).toHaveAttribute('aria-expanded', 'false'));
  });

  it('keeps the panel’s items menu items', () => {
    openUserMenu();

    // The panel is a `role="menu"`, and its logout sibling is a menuitem.
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();
  });
});
