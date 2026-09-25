import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const mockPresignAvatarUpload = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api.js')>()),
  changePassword: vi.fn(),
  getMe: (...args: unknown[]) => mockGetMe(...args),
  getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
  updateOrg: (...args: unknown[]) => mockUpdateOrg(...args),
  updatePreferences: vi.fn(),
  updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
  presignAvatarUpload: (...args: unknown[]) => mockPresignAvatarUpload(...args),
}));

global.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));

// MFA pulls in enrollment flows and WebAuthn; the company-name field is what
// this file is about.
vi.mock('../components/MfaSettings', () => ({ MfaSettings: () => null }));

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

import { SettingsPage } from './SettingsPage.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function me(role: OrgRole, overrides: Partial<MeResponse> = {}): MeResponse {
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
    ...overrides,
  };
}

function renderSettings(role: OrgRole, overrides: Partial<MeResponse> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role, me(role, overrides));
  mockGetMe.mockResolvedValue(me(role, overrides));
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

  it('closes without saving when the address is the one on file', async () => {
    renderSettings(OrgRole.Admin);

    fireEvent.click(await screen.findByLabelText('Email'));
    fireEvent.change(await screen.findByLabelText('New email'), {
      target: { value: ' User@Example.com ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(screen.queryByLabelText('New email')).not.toBeInTheDocument());
    expect(mockUpdateProfile).not.toHaveBeenCalled();
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

describe('SettingsPage — the avatar picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads the picked file and saves it, with no extra Save step', async () => {
    mockPresignAvatarUpload.mockResolvedValue({
      uploadUrl: 'https://upload.example/post',
      fields: { key: 'avatars/new.png', tagging: '<Tagging/>' },
      pictureUrl: 'https://cdn.example/avatars/new.png',
    });
    mockUpdateProfile.mockResolvedValue({ picture: 'https://cdn.example/avatars/new.png' });
    renderSettings(OrgRole.Admin);

    const trigger = await screen.findByLabelText('Change avatar');
    const input = trigger.parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['data'], 'avatar.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(mockPresignAvatarUpload).toHaveBeenCalledWith({ contentType: 'image/png' }),
    );
    await waitFor(() =>
      expect(mockUpdateProfile).toHaveBeenCalledWith({
        pictureUrl: 'https://cdn.example/avatars/new.png',
      }),
    );
    expect(await screen.findByText('Avatar updated')).toBeInTheDocument();

    // A multipart POST carrying the policy's fields, so S3 enforces the size
    // ceiling and the unclaimed tag the presign step signed.
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://upload.example/post');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect(form.get('key')).toBe('avatars/new.png');
    expect(form.get('tagging')).toBe('<Tagging/>');
    expect(form.get('file')).toBe(file);
  });

  it('rejects a file that is too large before uploading anything', async () => {
    renderSettings(OrgRole.Admin);

    const trigger = await screen.findByLabelText('Change avatar');
    const input = trigger.parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
    const tooBig = new File([new Uint8Array(3 * 1024 * 1024)], 'huge.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [tooBig] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('under 2MB');
    expect(mockPresignAvatarUpload).not.toHaveBeenCalled();
  });

  // Visible without hover, so touch and keyboard users can see it running, and
  // closed to a second pick that would race the first.
  it('shows the upload in progress and takes no second pick meanwhile', async () => {
    mockPresignAvatarUpload.mockReturnValue(new Promise(() => {}));
    renderSettings(OrgRole.Admin);

    const trigger = await screen.findByLabelText('Change avatar');
    const input = trigger.parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['data'], 'avatar.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(trigger).toBeDisabled());
    expect(trigger).toHaveAttribute('aria-busy', 'true');
  });

  // The provider owns a social account's picture like its name and email:
  // Auth0 re-syncs it on login, so an upload here would not last.
  it('shows a social account the provider picture, with where to change it', async () => {
    renderSettings(OrgRole.Admin, { connectionType: 'google-oauth2' });

    const avatarBlock = (await screen.findByText('Avatar')).parentElement!;
    expect(screen.queryByLabelText('Change avatar')).not.toBeInTheDocument();
    expect(within(avatarBlock).getByText(/Managed by Google/)).toBeInTheDocument();
    expect(within(avatarBlock).getByRole('link', { name: 'Update at Google' })).toBeInTheDocument();
  });

  // Any connection but the database one is social, including one this build
  // has no name or profile page for.
  it('says who owns a social picture even when the provider is not one it knows', async () => {
    renderSettings(OrgRole.Admin, { connectionType: 'samlp' });

    const avatarBlock = (await screen.findByText('Avatar')).parentElement!;
    expect(screen.queryByLabelText('Change avatar')).not.toBeInTheDocument();
    expect(within(avatarBlock).getByText('Managed by your sign-in provider.')).toBeInTheDocument();
    expect(within(avatarBlock).queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('SettingsPage — the danger zone', () => {
  it('points at support rather than opening a deletion flow that does not exist yet', async () => {
    renderSettings(OrgRole.Admin);

    expect(await screen.findByText('Danger zone')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'support@fil.one' });
    expect(link).toHaveAttribute('href', 'mailto:support@fil.one');
  });
});
