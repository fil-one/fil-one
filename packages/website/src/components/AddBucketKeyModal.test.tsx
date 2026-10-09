import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { S3Region } from '@filone/shared';

import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from './Toast/ToastProvider.js';

const mockCreateAccessKey = vi.fn();
vi.mock('../lib/api.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/api.js')>('../lib/api.js')),
  createAccessKey: (...args: unknown[]) => mockCreateAccessKey(...args),
}));

// Every test here is about a region serving the `iam` access model.
vi.mock('../lib/access-model.js', () => ({ isIamRegion: () => true }));

import { AddBucketKeyModal } from './AddBucketKeyModal.js';

const BUCKET = 'my-bucket';
const POLICY_SIDEBAR_HEADING = 'Follows the bucket policies';

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(qc);
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AddBucketKeyModal
          open
          onClose={() => {}}
          bucketName={BUCKET}
          region={S3Region.UsEast1}
          onKeyAdded={() => {}}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('AddBucketKeyModal — on an iam region', () => {
  beforeEach(() => {
    mockCreateAccessKey.mockReset();
    mockCreateAccessKey.mockResolvedValue({ accessKeyId: 'AKIA', secretAccessKey: 'secret' });
  });

  it('sends only name, region and expiry for a personal key', async () => {
    renderModal();
    fireEvent.change(await screen.findByLabelText('Key name'), { target: { value: 'ci key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    await waitFor(() =>
      expect(mockCreateAccessKey).toHaveBeenCalledWith({
        keyName: 'ci key',
        region: S3Region.UsEast1,
        expiresAt: null,
      }),
    );
  });

  it('hides the bucket-policy sidebar advice once Service key is chosen', async () => {
    renderModal();
    expect(await screen.findByText(POLICY_SIDEBAR_HEADING)).toBeInTheDocument();

    fireEvent.click(await screen.findByLabelText(/Service key/));
    await screen.findByText('What can this key do?');
    expect(screen.queryByText(POLICY_SIDEBAR_HEADING)).not.toBeInTheDocument();
  });
});
