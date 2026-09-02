import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, ROLE_PERMISSIONS } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';

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
    nameConfirmed: true,
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
async function saveNewEmail() {
  fireEvent.change(await screen.findByLabelText('Email'), {
    target: { value: 'new@example.com' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsPage — saving a new email address', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateProfile.mockResolvedValue({ name: 'Ada', email: 'new@example.com' });
  });

  it('sends the user to verify the address', async () => {
    renderSettings(OrgRole.Admin);
    await saveNewEmail();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/verify-email' }));
  });
});
