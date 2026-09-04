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

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => ({}),
}));

import { SettingsPage } from './SettingsPage.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function me(role: OrgRole): MeResponse {
  return {
    orgId: 'org-1',
    orgName: 'Acme',
    slug: 'acme',
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

/** Open the email modal, type a new address, and press Update. */
async function saveNewEmail() {
  fireEvent.click(await screen.findByLabelText('Email'));
  fireEvent.change(await screen.findByLabelText('New email'), {
    target: { value: 'new@example.com' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsPage — changing the email address', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateProfile.mockResolvedValue({ name: 'Ada', email: 'new@example.com' });
  });

  it('sends the user to verify the address', async () => {
    renderSettings(OrgRole.Admin);
    await saveNewEmail();

    await waitFor(() =>
      expect(mockUpdateProfile).toHaveBeenCalledWith({ email: 'new@example.com' }),
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/verify-email' }));
  });

  it('closes over a Cancel without saving anything', async () => {
    renderSettings(OrgRole.Admin);

    fireEvent.click(await screen.findByLabelText('Email'));
    fireEvent.change(await screen.findByLabelText('New email'), {
      target: { value: 'abandoned@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockUpdateProfile).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByLabelText('New email')).not.toBeInTheDocument());
  });

  it('opens from the keyboard, not just a click', async () => {
    renderSettings(OrgRole.Admin);

    fireEvent.keyDown(await screen.findByLabelText('Email'), { key: 'Enter' });

    expect(await screen.findByLabelText('New email')).toBeInTheDocument();
  });
});

describe('SettingsPage — the name field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves on blur without a Save button', async () => {
    mockUpdateProfile.mockResolvedValue({ name: 'Ada Lovelace' });
    renderSettings(OrgRole.Admin);

    const nameField = await screen.findByLabelText('Name');
    fireEvent.change(nameField, { target: { value: 'Ada Lovelace' } });
    fireEvent.blur(nameField);

    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalledWith({ name: 'Ada Lovelace' }));
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('does nothing on blur when the name did not change', async () => {
    renderSettings(OrgRole.Admin);

    const nameField = await screen.findByLabelText('Name');
    fireEvent.blur(nameField);

    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });
});
