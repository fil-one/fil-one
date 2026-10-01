import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';

const mockApiRequest = vi.fn();
const mockCreateAccessKey = vi.fn();

vi.mock('../lib/api.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/api.js')>('../lib/api.js')),
  apiRequest: (...a: unknown[]) => mockApiRequest(...a),
  createAccessKey: (...a: unknown[]) => mockCreateAccessKey(...a),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

// Every test here is about a region serving the `iam` access model.
vi.mock('../lib/access-model.js', () => ({ isIamRegion: () => true }));

import { CreateBucketPage } from './CreateBucketPage.js';

const BUCKET = 'my-bucket';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(qc);
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <CreateBucketPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function fillWithServiceKey() {
  renderPage();
  fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: BUCKET } });
  fireEvent.click(screen.getByText('Create new key'));
  fireEvent.change(await screen.findByLabelText('Key name'), { target: { value: 'ci key' } });
  fireEvent.click(await screen.findByLabelText(/Service key/));
  await screen.findByText('What can this key do?');
}

describe('CreateBucketPage — a service key on an iam region', () => {
  beforeEach(() => {
    mockApiRequest.mockReset();
    mockCreateAccessKey.mockReset();
    mockApiRequest.mockResolvedValue({ bucket: { bucketName: BUCKET } });
    mockCreateAccessKey.mockResolvedValue({ accessKeyId: 'AKIA', secretAccessKey: 'secret' });
  });

  it('creates the key with its permissions and bucket after the bucket', async () => {
    await fillWithServiceKey();
    fireEvent.click(screen.getByRole('button', { name: 'Create bucket and API key' }));

    await waitFor(() => expect(mockApiRequest).toHaveBeenCalledWith('/buckets', expect.anything()));
    await waitFor(() => expect(mockCreateAccessKey).toHaveBeenCalledTimes(1));
    expect(mockCreateAccessKey.mock.calls[0][0]).toMatchObject({
      keyName: 'ci key',
      bucketScope: 'specific',
      buckets: [BUCKET],
    });
  });

  it('will not create the bucket while the service key has no permissions', async () => {
    await fillWithServiceKey();
    for (const p of [
      'read',
      'write',
      'list',
      'GetBucketVersioning',
      'GetBucketObjectLockConfiguration',
    ]) {
      const box = within(screen.getByTestId(`permission-${p}`)).getByRole('checkbox');
      if (box.getAttribute('aria-checked') === 'true' || (box as HTMLInputElement).checked)
        fireEvent.click(box);
    }
    await screen.findByText('Select at least one permission.');

    const submit = screen.getByRole('button', { name: 'Create bucket and API key' });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(mockApiRequest).not.toHaveBeenCalledWith('/buckets', expect.anything());
  });
});
