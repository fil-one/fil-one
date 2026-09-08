import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse } from '@filone/shared';

const mockPresignAvatarUpload = vi.fn();
const mockUpdateProfile = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api.js')>()),
  presignAvatarUpload: (...args: unknown[]) => mockPresignAvatarUpload(...args),
  updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
}));

import { ToastProvider } from './Toast/ToastProvider.js';
import { ProfileAvatarPicker } from './ProfileAvatarPicker.js';

const ME: MeResponse = {
  orgId: 'org_acme',
  orgName: 'Acme Inc.',
  slug: 'acme-inc',
  nameConfirmed: true,
  emailVerified: true,
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  mfaEnrollments: [],
  ragAccess: false,
  orgsBeta: false,
  billingActive: true,
};

function renderPicker(me: MeResponse = ME) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ProfileAvatarPicker me={me} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function pngFile(name = 'avatar.png', sizeBytes = 1024) {
  const file = new File([new Uint8Array(sizeBytes)], name, { type: 'image/png' });
  return file;
}

describe('ProfileAvatarPicker', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders the initial when there is no picture yet', () => {
    renderPicker();

    expect(screen.getByRole('button', { name: 'Change avatar' })).toBeInTheDocument();
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('uploads a picked file and saves the profile', async () => {
    mockPresignAvatarUpload.mockResolvedValue({
      uploadUrl: 'https://upload.example/put',
      pictureUrl: 'https://cdn.example/avatars/new.png',
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    mockUpdateProfile.mockResolvedValue({ picture: 'https://cdn.example/avatars/new.png' });

    renderPicker();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pngFile()] } });

    await waitFor(() => {
      expect(mockUpdateProfile).toHaveBeenCalledWith({
        pictureUrl: 'https://cdn.example/avatars/new.png',
      });
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://upload.example/put',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('rejects a file of the wrong type before uploading anything', async () => {
    renderPicker();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const badFile = new File(['not an image'], 'notes.txt', { type: 'text/plain' });

    fireEvent.change(input, { target: { files: [badFile] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Avatar must be a PNG, JPEG, or WebP image.',
    );
    expect(mockPresignAvatarUpload).not.toHaveBeenCalled();
  });

  it('rejects a file over the size limit before uploading anything', async () => {
    renderPicker();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const tooBig = pngFile('huge.png', 20 * 1024 * 1024);

    fireEvent.change(input, { target: { files: [tooBig] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/must be under/);
    expect(mockPresignAvatarUpload).not.toHaveBeenCalled();
  });

  it('surfaces an error when the upload itself fails', async () => {
    mockPresignAvatarUpload.mockResolvedValue({
      uploadUrl: 'https://upload.example/put',
      pictureUrl: 'https://cdn.example/avatars/new.png',
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    renderPicker();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pngFile()] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed');
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });
});
