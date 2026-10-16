import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    billingActive: true,
    userId: 'user-1',
    role,
    permissions: ROLE_PERMISSIONS[role],
    memberships,
  };
}

/** Pick a PNG through the avatar button's hidden file input. */
function pickLogo(trigger: HTMLElement) {
  const input = trigger.parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(['data'], 'logo.png', { type: 'image/png' })] },
  });
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

    await waitFor(() => expect(mockUpdateOrg).toHaveBeenCalledWith({ name: 'Acme Two' }, ORG_ID));
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

describe('EditOrganizationPage: the avatar picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateOrg.mockResolvedValue({ name: 'Acme Two' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads the picked file and saves it, with no extra Save step', async () => {
    mockPresignOrgLogoUpload.mockResolvedValue({
      uploadUrl: 'https://upload.example/post',
      fields: {},
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
      expect(mockUpdateOrg).toHaveBeenCalledWith(
        { logoUrl: 'https://cdn.example/logos/new.png' },
        ORG_ID,
      ),
    );
    expect(await screen.findByText('Organization logo updated')).toBeInTheDocument();
  });

  it('puts the saved logo back when the save fails', async () => {
    mockPresignOrgLogoUpload.mockResolvedValue({
      uploadUrl: 'https://upload.example/post',
      fields: {},
      logoUrl: 'https://cdn.example/logos/new.png',
    });
    mockUpdateOrg.mockRejectedValue(new Error('Forbidden'));
    const { container } = renderPage(OrgRole.Owner);

    pickLogo(await screen.findByLabelText('Change avatar'));

    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
    await waitFor(() =>
      expect(container.querySelector('img[src="https://cdn.example/logos/new.png"]')).toBeNull(),
    );
  });

  it('saves to the org the logo was picked in, even after a switch', async () => {
    let finishPresign!: (value: unknown) => void;
    mockPresignOrgLogoUpload.mockReturnValue(
      new Promise((resolve) => {
        finishPresign = resolve;
      }),
    );
    mockUpdateOrg.mockResolvedValue({
      name: 'Acme',
      logoUrl: 'https://cdn.example/logos/new.png',
    });
    const memberships = [
      { orgId: ORG_ID, orgName: 'Acme', role: OrgRole.Owner },
      { orgId: 'org-2', orgName: 'Beta', role: OrgRole.Owner },
    ];
    const { client } = renderPage(OrgRole.Owner, memberships);
    pickLogo(await screen.findByLabelText('Change avatar'));

    // The tab moves to Beta while the upload is still in flight.
    const beta = { ...me(OrgRole.Owner, memberships), orgId: 'org-2', orgName: 'Beta' };
    act(() => {
      client.setQueryData(queryKeys.me, beta);
      client.setQueryData(queryKeys.meWithMfa, beta);
    });
    finishPresign({
      uploadUrl: 'https://upload.example/post',
      fields: {},
      logoUrl: 'https://cdn.example/logos/new.png',
    });

    await waitFor(() =>
      expect(mockUpdateOrg).toHaveBeenCalledWith(
        { logoUrl: 'https://cdn.example/logos/new.png' },
        ORG_ID,
      ),
    );
    await waitFor(() =>
      expect(client.getQueryData<MeResponse>(queryKeys.me)).toMatchObject({
        orgId: 'org-2',
        orgName: 'Beta',
        memberships: [
          { orgId: ORG_ID, logoUrl: 'https://cdn.example/logos/new.png' },
          { orgId: 'org-2', orgName: 'Beta' },
        ],
      }),
    );
    expect(client.getQueryData<MeResponse>(queryKeys.me)?.logoUrl).toBeUndefined();
  });

  // A rename that lands while the upload is running must survive the logo
  // save: the save sends no name, and takes the stored one from the reply.
  it('does not undo a rename saved while the logo was uploading', async () => {
    let finishPresign!: (value: unknown) => void;
    mockPresignOrgLogoUpload.mockReturnValue(
      new Promise((resolve) => {
        finishPresign = resolve;
      }),
    );
    const { client } = renderPage(OrgRole.Owner);
    pickLogo(await screen.findByLabelText('Change avatar'));

    mockUpdateOrg.mockResolvedValueOnce({ name: 'Acme Two' });
    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'Acme Two' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('This organization is called Acme Two now');

    mockUpdateOrg.mockResolvedValueOnce({
      name: 'Acme Two',
      logoUrl: 'https://cdn.example/logos/new.png',
    });
    finishPresign({
      uploadUrl: 'https://upload.example/post',
      fields: {},
      logoUrl: 'https://cdn.example/logos/new.png',
    });

    await waitFor(() =>
      expect(mockUpdateOrg).toHaveBeenLastCalledWith(
        { logoUrl: 'https://cdn.example/logos/new.png' },
        ORG_ID,
      ),
    );
    await waitFor(() =>
      expect(client.getQueryData<MeResponse>(queryKeys.me)).toMatchObject({
        orgName: 'Acme Two',
        logoUrl: 'https://cdn.example/logos/new.png',
      }),
    );
    expect(screen.getByLabelText('Organization name')).toHaveValue('Acme Two');
  });

  // Visible without hover, so touch and keyboard users can see it running.
  it('shows the upload in progress, and takes no second pick meanwhile', async () => {
    mockPresignOrgLogoUpload.mockReturnValue(new Promise(() => {}));
    renderPage(OrgRole.Owner);

    const trigger = await screen.findByLabelText('Change avatar');
    pickLogo(trigger);

    await waitFor(() => expect(trigger).toBeDisabled());
    expect(trigger).toHaveAttribute('aria-busy', 'true');
  });

  it('keeps a name that is still being typed when the logo saves', async () => {
    mockPresignOrgLogoUpload.mockResolvedValue({
      uploadUrl: 'https://upload.example/post',
      fields: {},
      logoUrl: 'https://cdn.example/logos/new.png',
    });
    mockUpdateOrg.mockResolvedValue({
      name: 'Acme',
      logoUrl: 'https://cdn.example/logos/new.png',
    });
    renderPage(OrgRole.Owner);

    const nameField = await screen.findByLabelText('Organization name');
    fireEvent.change(nameField, { target: { value: 'Acme Two' } });
    pickLogo(screen.getByLabelText('Change avatar'));

    expect(await screen.findByText('Organization logo updated')).toBeInTheDocument();
    expect(screen.getByLabelText('Organization name')).toHaveValue('Acme Two');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
