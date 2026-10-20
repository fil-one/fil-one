import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';

const mockApiRequest = vi.fn();

vi.mock('../lib/api.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/api.js')>('../lib/api.js')),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

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

function toggleAdvancedSettings() {
  fireEvent.click(screen.getByRole('button', { name: /Advanced settings/ }));
}

function getBucketRequestBody() {
  const call = mockApiRequest.mock.calls.find(
    ([path, init]) => path === '/buckets' && init?.method === 'POST',
  );
  return call && JSON.parse(call[1].body);
}

beforeEach(() => {
  mockApiRequest.mockReset();
  mockApiRequest.mockResolvedValue({ bucket: { bucketName: BUCKET } });
});

describe('CreateBucketPage — advanced settings', () => {
  it('hides the object settings until Advanced settings is opened', () => {
    renderPage();
    expect(screen.queryByRole('switch', { name: 'Versioning' })).not.toBeInTheDocument();

    toggleAdvancedSettings();

    expect(screen.getByRole('button', { name: /Advanced settings/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('switch', { name: 'Versioning' })).toBeInTheDocument();
  });

  it('keeps versioning on and names it in the summary after Advanced settings is closed', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: BUCKET } });
    toggleAdvancedSettings();
    fireEvent.click(screen.getByRole('switch', { name: 'Versioning' }));
    toggleAdvancedSettings();

    expect(screen.getByRole('button', { name: /Advanced settings/ })).toHaveTextContent(
      'Versioning on',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));
    await waitFor(() => expect(getBucketRequestBody()).toMatchObject({ versioning: true }));
  });

  it('creates the bucket with versioning off when Advanced settings is never opened', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: BUCKET } });

    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));

    await waitFor(() =>
      expect(getBucketRequestBody()).toMatchObject({
        bucketName: BUCKET,
        versioning: false,
        lock: false,
      }),
    );
  });
});

describe('CreateBucketPage — a name that is already taken', () => {
  // What apiRequest throws for the backend's 409 on a held name.
  const takenNameError = Object.assign(new Error(`Bucket "${BUCKET}" already exists`), {
    status: 409,
  });

  it('shows the taken name under the name field when the create call answers 409', async () => {
    mockApiRequest.mockRejectedValue(takenNameError);
    renderPage();
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: BUCKET } });

    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));

    expect(await screen.findByText('This name is already taken. Try another.')).toBeInTheDocument();
    expect(screen.getByLabelText('Bucket name')).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears the taken-name error once the name is edited', async () => {
    mockApiRequest.mockRejectedValue(takenNameError);
    renderPage();
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: BUCKET } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));
    await screen.findByText('This name is already taken. Try another.');

    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: 'any-other-name' } });

    expect(screen.queryByText('This name is already taken. Try another.')).not.toBeInTheDocument();
  });
});

describe('CreateBucketPage — an empty name', () => {
  it('asks for a name in the field and sends nothing when Create bucket is pressed', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));

    expect(screen.getByText('Enter a bucket name.')).toBeInTheDocument();
    expect(screen.getByLabelText('Bucket name')).toHaveFocus();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });
});
