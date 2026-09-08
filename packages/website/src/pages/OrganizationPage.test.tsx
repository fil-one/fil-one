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

global.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));

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
    billingActive: true,
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

  it("keeps the org's slug through a rename, since slugs never change", async () => {
    mockUpdateOrg.mockResolvedValue({ name: 'Acme Two', slug: 'acme' });
    const { client } = renderPage(OrgRole.Owner);

    const nameField = await screen.findByLabelText('Organization name');
    fireEvent.change(nameField, { target: { value: 'Acme Two' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(client.getQueryData<MeResponse>(queryKeys.me)).toMatchObject({
        orgName: 'Acme Two',
        slug: 'acme',
      }),
    );
  });

  it('refuses a name the schema will not take, without asking the server', async () => {
    renderPage(OrgRole.Owner);

    const nameField = await screen.findByLabelText('Organization name');
    fireEvent.change(nameField, { target: { value: 'no/slashes' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

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

  describe('the avatar picker', () => {
    it('uploads the picked file and saves it, with no extra Save step', async () => {
      mockPresignOrgLogoUpload.mockResolvedValue({
        uploadUrl: 'https://upload.example/put',
        logoUrl: 'https://cdn.example/logos/new.png',
      });
      mockUpdateOrg.mockResolvedValue({
        name: 'Acme',
        logoUrl: 'https://cdn.example/logos/new.png',
      });
      renderPage(OrgRole.Owner);

      const trigger = await screen.findByLabelText('Change avatar');
      const input = trigger.parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['data'], 'logo.png', { type: 'image/png' });
      fireEvent.change(input, { target: { files: [file] } });

      await waitFor(() =>
        expect(mockUpdateOrg).toHaveBeenCalledWith({
          name: 'Acme',
          logoUrl: 'https://cdn.example/logos/new.png',
        }),
      );
      expect(await screen.findByText('Organization logo updated')).toBeInTheDocument();
    });
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
