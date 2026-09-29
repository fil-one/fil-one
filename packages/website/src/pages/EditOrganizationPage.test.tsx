import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, ROLE_PERMISSIONS } from '@filone/shared';
import type { MeResponse, OrgMembershipSummary } from '@filone/shared';

import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { queryKeys } from '../lib/query-client.js';

const mockGetMe = vi.fn();
const mockUpdateOrg = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...actual,
    getMe: (...args: unknown[]) => mockGetMe(...args),
    updateOrg: (...args: unknown[]) => mockUpdateOrg(...args),
  };
});

global.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));

import { EditOrganizationPage } from './EditOrganizationPage.js';

const ORG_ID = 'org-1';

function me(
  role: OrgRole,
  memberships: OrgMembershipSummary[] = [{ orgId: ORG_ID, orgName: 'Acme', role }],
): MeResponse {
  return {
    orgId: ORG_ID,
    orgName: 'Acme',
    nameConfirmed: true,
    emailVerified: true,
    email: 'user@example.com',
    mfaEnrollments: [],
    ragAccess: true,
    orgsBeta: true,
    userId: 'user-1',
    role,
    permissions: ROLE_PERMISSIONS[role],
    memberships,
  };
}

function renderPage(role: OrgRole, memberships?: OrgMembershipSummary[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const account = me(role, memberships);
  seedPermissions(client, role, account);
  mockGetMe.mockResolvedValue(account);
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <EditOrganizationPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

describe('EditOrganizationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateOrg.mockResolvedValue({ name: 'Acme Two' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens on the org name it already has, with nothing to save', async () => {
    renderPage(OrgRole.Owner);

    expect(await screen.findByLabelText('Organization name')).toHaveValue('Acme');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('shows a Save button once the name changes, and saves on click', async () => {
    const { client } = renderPage(OrgRole.Owner);

    const nameField = await screen.findByLabelText('Organization name');
    fireEvent.change(nameField, { target: { value: 'Acme Two' } });
    expect(mockUpdateOrg).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdateOrg).toHaveBeenCalledWith({ name: 'Acme Two' }));
    await waitFor(() =>
      expect(client.getQueryData<MeResponse>(queryKeys.me)).toMatchObject({
        orgName: 'Acme Two',
        memberships: [{ orgId: ORG_ID, orgName: 'Acme Two' }],
      }),
    );
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('refuses a name the schema will not take, without asking the server', async () => {
    renderPage(OrgRole.Owner);

    const nameField = await screen.findByLabelText('Organization name');
    fireEvent.change(nameField, { target: { value: 'no/slashes' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });

  it('shows an error instead of a spinner when /me fails to load', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedPermissions(client, OrgRole.Owner, me(OrgRole.Owner));
    mockGetMe.mockRejectedValue(new Error('Could not load your account'));
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <EditOrganizationPage />
        </ToastProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Could not load your account')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading organization')).not.toBeInTheDocument();
  });

  it('shows a fallback instead of the form for a role without org.rename', async () => {
    renderPage(OrgRole.Member);

    expect(
      await screen.findByText(/managed by your organization.s owners and admins/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Organization name')).not.toBeInTheDocument();
  });

  describe('the danger zone', () => {
    it('shows Delete organization to an Owner, pointed at support', async () => {
      renderPage(OrgRole.Owner);

      expect(await screen.findByText('Delete organization')).toBeInTheDocument();
      const link = screen.getByRole('link', { name: 'support@fil.one' });
      expect(link).toHaveAttribute('href', 'mailto:support@fil.one');
      expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });

    it('hides Delete organization from an Admin, who can rename but not delete', async () => {
      renderPage(OrgRole.Admin);

      // The rename form is there — org.rename holds — but not the danger zone.
      expect(await screen.findByLabelText('Organization name')).toBeInTheDocument();
      expect(screen.queryByText('Delete organization')).not.toBeInTheDocument();
    });
  });
});
