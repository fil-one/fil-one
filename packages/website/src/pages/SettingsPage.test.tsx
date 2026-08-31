import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, ROLE_PERMISSIONS } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { queryKeys } from '../lib/query-client.js';

// ---------------------------------------------------------------------------
// Mocks — the network boundary, plus the two panels this file is not about
// ---------------------------------------------------------------------------

const mockGetMe = vi.fn();
const mockGetPreferences = vi.fn();
const mockUpdateProfile = vi.fn();
const mockUpdateOrg = vi.fn();

vi.mock('../lib/api.js', () => ({
  changePassword: vi.fn(),
  getMe: (...args: unknown[]) => mockGetMe(...args),
  getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
  updateOrg: (...args: unknown[]) => mockUpdateOrg(...args),
  updatePreferences: vi.fn(),
  updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
}));

// MFA pulls in enrollment flows and WebAuthn; the company-name field is what
// this file is about.
vi.mock('../components/MfaSettings', () => ({ MfaSettings: () => null }));

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));

import { SettingsPage } from './SettingsPage.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function me(role: OrgRole): MeResponse {
  return {
    orgId: 'org-1',
    orgName: 'Acme',
    emailVerified: true,
    email: 'user@example.com',
    name: 'Ada',
    connectionType: 'auth0',
    mfaEnrollments: [],
    ragAccess: true,
    orgsBeta: true,
    userId: 'user-1',
    role,
    permissions: ROLE_PERMISSIONS[role],
  };
}

function renderSettings(role: OrgRole) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role, me(role));
  mockGetMe.mockResolvedValue(me(role));
  mockGetPreferences.mockResolvedValue({ marketingEmails: false, productUpdates: false });
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <SettingsPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/** Type a new address and a new company name, then press Save. */
async function saveEmailAndOrgName() {
  fireEvent.change(await screen.findByLabelText('Email'), {
    target: { value: 'new@example.com' },
  });
  fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Acme Two' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsPage — the company name field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is editable for a role that holds org.rename', async () => {
    renderSettings(OrgRole.Admin);

    const field = await screen.findByLabelText('Company name');
    expect(field).not.toBeDisabled();
  });

  it.each([OrgRole.Member, OrgRole.ReadOnly])(
    'stays visible but read-only for %s',
    async (role) => {
      // The org's name is worth showing — it names where the caller is working.
      // Renaming it is PATCH /api/org, which the server refuses below Admin.
      renderSettings(role);

      const field = await screen.findByLabelText('Company name');
      expect(field).toBeDisabled();
      expect(field).toHaveValue('Acme');
    },
  );
});

describe('SettingsPage — saving a new email address', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateProfile.mockResolvedValue({ name: 'Ada', email: 'new@example.com' });
    mockUpdateOrg.mockResolvedValue({ name: 'Acme Two' });
  });

  it('sends the user to verify the address', async () => {
    renderSettings(OrgRole.Admin);
    await saveEmailAndOrgName();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/verify-email' }));
  });

  it('still sends them when the rename fails after the email landed', async () => {
    // The profile PATCH runs first and the rename second, so a rename failure
    // leaves the session holding an unverified address. Without the redirect the
    // tab stays on Settings, emailVerified false, with no funnel until the next
    // gated request.
    mockUpdateOrg.mockRejectedValue(new Error('You cannot rename this organization'));

    const { client } = renderSettings(OrgRole.Admin);
    await saveEmailAndOrgName();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/verify-email' }));
    // The failure is still reported, and the half that landed still reaches the
    // cache the rest of the app reads.
    expect(await screen.findByText('You cannot rename this organization')).toBeInTheDocument();
    expect(client.getQueryData<MeResponse>(queryKeys.me)).toMatchObject({
      email: 'new@example.com',
      emailVerified: false,
    });
  });

  it('stays on the page when only the org name changed', async () => {
    renderSettings(OrgRole.Admin);

    fireEvent.change(await screen.findByLabelText('Company name'), {
      target: { value: 'Acme Two' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Profile updated')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
