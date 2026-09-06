import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockPresignOrgLogoUpload = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api.js')>()),
  presignOrgLogoUpload: (...args: unknown[]) => mockPresignOrgLogoUpload(...args),
}));

import { AvatarPicker, useOrgLogoUpload } from './OrgLogoPicker.js';

/** `AvatarPicker` only renders the state `useOrgLogoUpload` produces, so it
 * needs a small host to hold that hook's state across the picker's own
 * lifetime, the same way any real dialog does. */
function Host({
  layout,
  onUploaded,
}: {
  layout?: 'dialog' | 'row';
  onUploaded?: (logoUrl: string) => void;
}) {
  const logo = useOrgLogoUpload(undefined, onUploaded);
  return <AvatarPicker name="Acme" logo={logo} disabled={false} layout={layout} />;
}

function pngFile(name = 'logo.png', sizeBytes = 1024) {
  return new File([new Uint8Array(sizeBytes)], name, { type: 'image/png' });
}

describe('OrgLogoPicker', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders the picker with no logo yet', () => {
    render(<Host />);

    expect(screen.getByRole('button', { name: 'Choose avatar' })).toBeInTheDocument();
  });

  it('uploads a picked file and reports the uploaded URL', async () => {
    const onUploaded = vi.fn();
    mockPresignOrgLogoUpload.mockResolvedValue({
      uploadUrl: 'https://upload.example/put',
      logoUrl: 'https://cdn.example/logos/new.png',
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    render(<Host onUploaded={onUploaded} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pngFile()] } });

    await waitFor(() => {
      expect(onUploaded).toHaveBeenCalledWith('https://cdn.example/logos/new.png');
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://upload.example/put',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('rejects a file of the wrong type before uploading anything', async () => {
    render(<Host />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const badFile = new File(['not an image'], 'notes.txt', { type: 'text/plain' });

    fireEvent.change(input, { target: { files: [badFile] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Logo must be a PNG, JPEG, or WebP image.',
    );
    expect(mockPresignOrgLogoUpload).not.toHaveBeenCalled();
  });

  it('rejects a file over the size limit before uploading anything', async () => {
    render(<Host />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const tooBig = pngFile('huge.png', 20 * 1024 * 1024);

    fireEvent.change(input, { target: { files: [tooBig] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/must be under/);
    expect(mockPresignOrgLogoUpload).not.toHaveBeenCalled();
  });

  it('surfaces an error when the upload itself fails', async () => {
    mockPresignOrgLogoUpload.mockResolvedValue({
      uploadUrl: 'https://upload.example/put',
      logoUrl: 'https://cdn.example/logos/new.png',
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    render(<Host />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pngFile()] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed');
  });

  it('renders the row layout with its own caption', () => {
    render(<Host layout="row" />);

    expect(screen.getByRole('button', { name: 'Change avatar' })).toBeInTheDocument();
    expect(screen.getByText('Avatar')).toBeInTheDocument();
  });
});
