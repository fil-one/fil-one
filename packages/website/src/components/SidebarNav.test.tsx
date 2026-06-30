import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

import { SidebarNav } from './SidebarNav';

// Render <a>/no-op router primitives so SidebarNav can mount without a router.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useMatchRoute: () => () => false,
}));

// Force both status banners to render so their button ids are present.
vi.mock('./use-sidebar-data.js', () => ({
  useSidebarData: () => ({
    me: { name: 'Ada', email: 'ada@example.com', orgName: 'Acme' },
    displayName: 'Ada',
    initial: 'A',
    isTrialing: true,
    isPastDue: true,
    trialDays: 5,
    trialEndsLabel: 'Expires soon',
    graceDays: 3,
    graceEndsLabel: 'Expires soon',
    storageUsed: 1,
    storagePct: 10,
    egressUsed: 1,
    egressPct: 10,
  }),
}));

// RAG access is gated by useRagAccess() (FIL-555). Mock it so the gate can be
// driven directly — its real implementation needs a QueryClientProvider, which
// these mock-based render helpers intentionally avoid.
vi.mock('../lib/use-rag-access.js', () => ({ useRagAccess: vi.fn(() => false) }));

vi.mock('./Tooltip.js', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./StatusIndicator.js', () => ({
  StatusIndicator: () => <div data-testid="status-indicator" />,
}));

vi.mock('../lib/api.js', () => ({ logout: vi.fn() }));

import { useRagAccess } from '../lib/use-rag-access.js';

const mockUseRagAccess = vi.mocked(useRagAccess);

// Mirrors how AppShell mounts the sidebar twice: the visible desktop sidebar
// plus the mobile drawer copy. The drawer copy must not duplicate the
// page-unique e2e selectors, or Playwright strict-mode locators break.
function renderBothSidebars() {
  return render(
    <>
      <SidebarNav collapsed={false} onToggle={() => {}} showTestIds={true} />
      <SidebarNav
        collapsed={false}
        onToggle={() => {}}
        onClose={() => {}}
        showUserProfile={false}
        showTestIds={false}
      />
    </>,
  );
}

const UNIQUE_IDS = ['sidebar-upgrade-button', 'sidebar-update-payment-button'];
const UNIQUE_TESTIDS = [
  'nav-dashboard',
  'nav-buckets',
  'nav-api-keys',
  'nav-billing',
  'nav-settings',
  'user-profile',
];

describe('SidebarNav e2e selector uniqueness (desktop + drawer mounted)', () => {
  beforeEach(() => {
    mockUseRagAccess.mockReturnValue(false);
  });

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

describe('SidebarNav RAG Pipeline gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderSidebar() {
    return render(<SidebarNav collapsed={false} onToggle={() => {}} showTestIds={true} />);
  }

  it('shows the RAG Pipeline nav item for users with RAG access', () => {
    mockUseRagAccess.mockReturnValue(true);
    const { container } = renderSidebar();

    const item = container.querySelector('[data-testid="nav-rag-pipeline"]');
    expect(item).not.toBeNull();
    expect(item).toHaveAttribute('href', '/rag-pipeline');
    expect(item).toHaveTextContent('RAG Pipeline');
  });

  it('hides the RAG Pipeline nav item for users without RAG access', () => {
    mockUseRagAccess.mockReturnValue(false);
    const { container } = renderSidebar();

    // The AI Tools group still renders so we can assert the gate is specific.
    expect(container.querySelector('[data-testid="nav-ai-agent-toolkit"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="nav-rag-pipeline"]')).toBeNull();
  });
});
