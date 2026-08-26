import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks — the router (navigation is the assertion) and the API boundary
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
  useSearch: () => ({}),
}));

const mockGetMe = vi.fn();
const mockGetPreferences = vi.fn();
const mockUpdateProfile = vi.fn();
const mockUpdateOrg = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api.js')>()),
  getMe: (...a: unknown[]) => mockGetMe(...a),
  getPreferences: (...a: unknown[]) => mockGetPreferences(...a),
  updateProfile: (...a: unknown[]) => mockUpdateProfile(...a),
  updateOrg: (...a: unknown[]) => mockUpdateOrg(...a),
}));

import { SettingsPage } from './SettingsPage.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { queryKeys } from '../lib/query-client.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ME: MeResponse = {
  orgId: 'org-1',
  orgName: 'Acme',
  email: 'user@example.com',
  emailVerified: true,
  name: 'User',
  mfaEnrollments: [],
  ragAccess: false,
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMe.mockResolvedValue(ME);
  mockGetPreferences.mockResolvedValue({ marketingEmailsOptedIn: false });
  mockUpdateProfile.mockResolvedValue({ name: 'User', email: 'new@example.com' });
  mockUpdateOrg.mockResolvedValue({ name: 'Acme Two' });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('saving a new email address', () => {
  it('sends the user to verify the address', async () => {
    renderPage();
    await saveEmailAndOrgName();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/verify-email' }));
  });

  it('still sends them when the rename fails after the email landed', async () => {
    // The profile PATCH runs first and the rename second, so a rename failure
    // leaves the session holding an unverified address. Without the redirect the
    // tab stays on Settings, verified:false, with no funnel until the next
    // gated request.
    mockUpdateOrg.mockRejectedValue(new Error('You cannot rename this organization'));

    const { client } = renderPage();
    await saveEmailAndOrgName();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/verify-email' }));
    // The failure is still reported, and the half that landed still reaches the
    // cache the rest of the app reads.
    expect(await screen.findByText('You cannot rename this organization')).toBeInTheDocument();
    expect(client.getQueryData<MeResponse>(queryKeys.meWithMfa)).toMatchObject({
      email: 'new@example.com',
      emailVerified: false,
    });
  });

  it('stays on the page when only the org name changed', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText('Company name'), {
      target: { value: 'Acme Two' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Profile updated')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
