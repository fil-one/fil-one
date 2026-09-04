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
const mockPresignOrgLogoUpload = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...actual,
    getMe: (...args: unknown[]) => mockGetMe(...args),
    updateOrg: (...args: unknown[]) => mockUpdateOrg(...args),
    presignOrgLogoUpload: (...args: unknown[]) => mockPresignOrgLogoUpload(...args),
  };
});

// The Delete button is disabled while self-serve deletion is withheld
// (FIL-919) — on in this file so the danger zone's own behavior, not the
// unrelated flag, is what these tests exercise.
vi.mock('../lib/account-deletion.js', () => ({ ACCOUNT_DELETION_ENABLED: true }));

import { OrganizationPage } from './OrganizationPage.js';

const ORG_ID = 'org-1';

function me(
  role: OrgRole,
  memberships: OrgMembershipSummary[] = [{ orgId: ORG_ID, orgName: 'Acme', slug: 'acme', role }],
): MeResponse {
  return {
    orgId: ORG_ID,
    orgName: 'Acme',
    slug: 'acme',
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
        <OrganizationPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

describe('OrganizationPage', () => {
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
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('saves a rename and writes it into every cache that reads the name', async () => {
    const { client } = renderPage(OrgRole.Owner);

    fireEvent.change(await screen.findByLabelText('Organization name'), {
      target: { value: 'Acme Two' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateOrg).toHaveBeenCalledWith({ name: 'Acme Two' }));
    await waitFor(() =>
      expect(client.getQueryData<MeResponse>(queryKeys.me)).toMatchObject({
        orgName: 'Acme Two',
        memberships: [{ orgId: ORG_ID, orgName: 'Acme Two' }],
      }),
    );
  });

  it('refuses a name the schema will not take, without asking the server', async () => {
    renderPage(OrgRole.Owner);

    fireEvent.change(await screen.findByLabelText('Organization name'), {
      target: { value: 'no/slashes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });

  it('shows a fallback instead of the form for a role without org.rename', async () => {
    renderPage(OrgRole.Member);

    expect(
      await screen.findByText(/managed by your organization.s owners and admins/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Organization name')).not.toBeInTheDocument();
  });

  describe('the danger zone', () => {
    it('shows Delete organization to an Owner', async () => {
      renderPage(OrgRole.Owner);

      expect(await screen.findByText('Delete organization')).toBeInTheDocument();
    });

    it('hides Delete organization from an Admin, who can rename but not delete', async () => {
      renderPage(OrgRole.Admin);

      // The rename form is there — org.rename holds — but not the danger zone.
      expect(await screen.findByLabelText('Organization name')).toBeInTheDocument();
      expect(screen.queryByText('Delete organization')).not.toBeInTheDocument();
    });

    it("warns about losing sign-in when this is the caller's only org", async () => {
      renderPage(OrgRole.Owner, [
        { orgId: ORG_ID, orgName: 'Acme', slug: 'acme', role: OrgRole.Owner },
      ]);

      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

      expect(await screen.findByText(/your sign-in stops working too/)).toBeInTheDocument();
    });

    it('says the account survives when the caller belongs to other orgs too', async () => {
      renderPage(OrgRole.Owner, [
        { orgId: ORG_ID, orgName: 'Acme', slug: 'acme', role: OrgRole.Owner },
        { orgId: 'org-2', orgName: 'Globex', slug: 'globex', role: OrgRole.Member },
      ]);

      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

      expect(await screen.findByText(/you keep your account and sign-in/i)).toBeInTheDocument();
    });
  });
});
