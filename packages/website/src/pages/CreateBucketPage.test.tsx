import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { S3_REGION } from '@filone/shared';

const mockApiRequest = vi.fn();
const mockCreateAccessKey = vi.fn();

vi.mock('../lib/api.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/api.js')>('../lib/api.js')),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  createAccessKey: (...args: unknown[]) => mockCreateAccessKey(...args),
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

async function renderPageWithKeyNamed() {
  renderPage();
  fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: BUCKET } });
  fireEvent.click(screen.getByText('Create new key'));
  fireEvent.change(await screen.findByLabelText('Key name'), { target: { value: 'ci key' } });
}

async function renderPageWithServiceKeyChosen() {
  await renderPageWithKeyNamed();
  fireEvent.click(await screen.findByLabelText(/Service key/));
  await screen.findByText('What can this key do?');
}

function uncheckAllPermissions() {
  for (const box of within(screen.getByTestId('access-key-permissions')).getAllByRole('checkbox')) {
    if (box.getAttribute('aria-checked') === 'true' || (box as HTMLInputElement).checked)
      fireEvent.click(box);
  }
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Create bucket and API key' }));
}

beforeEach(() => {
  mockApiRequest.mockReset();
  mockCreateAccessKey.mockReset();
  mockApiRequest.mockResolvedValue({ bucket: { bucketName: BUCKET } });
  mockCreateAccessKey.mockResolvedValue({ accessKeyId: 'AKIA', secretAccessKey: 'secret' });
});

describe('CreateBucketPage — a service key on an iam region', () => {
  it('creates the key with its permissions and bucket after the bucket', async () => {
    await renderPageWithServiceKeyChosen();
    submit();

    await waitFor(() =>
      expect(mockCreateAccessKey).toHaveBeenCalledWith({
        keyName: 'ci key',
        permissions: [
          'read',
          'write',
          'list',
          'GetBucketVersioning',
          'GetBucketObjectLockConfiguration',
        ],
        bucketScope: 'specific',
        buckets: [BUCKET],
        region: S3_REGION,
        expiresAt: null,
      }),
    );
    const bucketCall = mockApiRequest.mock.calls.findIndex(
      ([path, init]) => path === '/buckets' && init?.method === 'POST',
    );
    expect(mockApiRequest.mock.invocationCallOrder[bucketCall]).toBeLessThan(
      mockCreateAccessKey.mock.invocationCallOrder[0],
    );
  });

  it('disables Create bucket and API key while a service key has no permissions', async () => {
    await renderPageWithServiceKeyChosen();
    uncheckAllPermissions();
    await screen.findByText('Select at least one permission.');

    expect(screen.getByRole('button', { name: 'Create bucket and API key' })).toBeDisabled();
    submit();
    expect(mockApiRequest).not.toHaveBeenCalledWith('/buckets', expect.anything());
  });
});

describe('CreateBucketPage — a personal key on an iam region', () => {
  it('creates a personal key with name and expiry only', async () => {
    await renderPageWithKeyNamed();
    submit();

    await waitFor(() =>
      expect(mockCreateAccessKey).toHaveBeenCalledWith({
        keyName: 'ci key',
        region: S3_REGION,
        expiresAt: null,
      }),
    );
  });
});
