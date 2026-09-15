import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, ROLE_PERMISSIONS } from '@filone/shared';
import { seedPermissions } from '../lib/test-permissions.js';

const mockGetMe = vi.fn();
vi.mock('../lib/api.js', () => ({ getMe: () => mockGetMe() }));

// The tab's own data-fetching and rendering are covered by
// OrganizationAuditTab.test.tsx; this file is about the gate around it.
vi.mock('./OrganizationAuditTab.js', () => ({
  OrganizationAuditTab: () => <div data-testid="audit-tab" />,
}));

import { AuditPage } from './AuditPage.js';

function renderPage(role: OrgRole = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  return render(
    <QueryClientProvider client={client}>
      <AuditPage />
    </QueryClientProvider>,
  );
}

describe('AuditPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('holds the page while /me is in flight, rendering neither the tab nor the fallback', () => {
    mockGetMe.mockReturnValue(new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuditPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Audit log')).toBeInTheDocument();
    expect(screen.queryByTestId('audit-tab')).not.toBeInTheDocument();
    expect(screen.queryByText(/available to your organization/)).not.toBeInTheDocument();
  });

  it('tells a Member the log is not theirs, without rendering the tab', async () => {
    renderPage(OrgRole.Member);

    expect(
      await screen.findByText(
        'The audit log is available to your organization’s owners and admins.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('audit-tab')).not.toBeInTheDocument();
  });

  it('tells a ReadOnly member the same thing', async () => {
    renderPage(OrgRole.ReadOnly);

    expect(
      await screen.findByText(
        'The audit log is available to your organization’s owners and admins.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('audit-tab')).not.toBeInTheDocument();
  });

  it('renders the tab for an Admin', async () => {
    renderPage(OrgRole.Admin);

    expect(await screen.findByTestId('audit-tab')).toBeInTheDocument();
  });

  it('renders the tab for an Owner', async () => {
    renderPage(OrgRole.Owner);

    expect(await screen.findByTestId('audit-tab')).toBeInTheDocument();
  });

  it('always shows the page title, whatever the role holds', async () => {
    renderPage(OrgRole.Member);
    expect(await screen.findByText('Audit log')).toBeInTheDocument();
  });

  it('holds the permission list ROLE_PERMISSIONS reports for reference', () => {
    // Sanity check on the fixture itself: audit.view is Owner/Admin only,
    // which is what the tests above assume.
    expect(ROLE_PERMISSIONS[OrgRole.Owner]).toContain('audit.view');
    expect(ROLE_PERMISSIONS[OrgRole.Admin]).toContain('audit.view');
    expect(ROLE_PERMISSIONS[OrgRole.Member]).not.toContain('audit.view');
    expect(ROLE_PERMISSIONS[OrgRole.ReadOnly]).not.toContain('audit.view');
  });
});
