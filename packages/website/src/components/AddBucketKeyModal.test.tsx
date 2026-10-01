import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { S3Region } from '@filone/shared';

import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from './Toast/ToastProvider.js';

const mockCreateAccessKey = vi.fn();
vi.mock('../lib/api.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/api.js')>('../lib/api.js')),
  createAccessKey: (...a: unknown[]) => mockCreateAccessKey(...a),
}));

// Every test here is about a region serving the `iam` access model.
vi.mock('../lib/access-model.js', () => ({ isIamRegion: () => true }));

import { AddBucketKeyModal } from './AddBucketKeyModal.js';

const BUCKET = 'my-bucket';
const POLICY_GUIDANCE = 'Follows the bucket policies';

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

  it('sends a personal key with no bucket on it', async () => {
    renderModal();
    fireEvent.change(await screen.findByLabelText('Key name'), { target: { value: 'ci key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));

    await waitFor(() => expect(mockCreateAccessKey).toHaveBeenCalledTimes(1));
    const body = mockCreateAccessKey.mock.calls[0][0];
    expect(body).not.toHaveProperty('bucketScope');
    expect(body).not.toHaveProperty('buckets');
  });

  it('drops the bucket-policy guidance once a service key is chosen', async () => {
    renderModal();
    expect(await screen.findByText(POLICY_GUIDANCE)).toBeInTheDocument();

    fireEvent.click(await screen.findByLabelText(/Service key/));
    await screen.findByText('What can this key do?');
    expect(screen.queryByText(POLICY_GUIDANCE)).not.toBeInTheDocument();
  });
});
