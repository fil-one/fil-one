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
  it('hides the object settings while Advanced settings is closed', () => {
    renderPage();

    expect(screen.queryByRole('switch', { name: 'Versioning' })).not.toBeInTheDocument();
  });

  it('shows the object settings once Advanced settings is opened', () => {
    renderPage();

    toggleAdvancedSettings();

    expect(screen.getByRole('switch', { name: 'Versioning' })).toBeInTheDocument();
  });

  it('names versioning in the summary after Advanced settings is closed with it on', () => {
    renderPage();
    toggleAdvancedSettings();
    fireEvent.click(screen.getByRole('switch', { name: 'Versioning' }));

    toggleAdvancedSettings();

    expect(screen.getByRole('button', { name: /Advanced settings/ })).toHaveTextContent(
      'Versioning on',
    );
  });

  it('creates the bucket with versioning on after Advanced settings is closed', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: BUCKET } });
    toggleAdvancedSettings();
    fireEvent.click(screen.getByRole('switch', { name: 'Versioning' }));
    toggleAdvancedSettings();

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

  it('puts the cursor back in the name field when the create call answers 409', async () => {
    mockApiRequest.mockRejectedValue(takenNameError);
    renderPage();
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: BUCKET } });

    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));

    await screen.findByText('This name is already taken. Try another.');
    expect(screen.getByLabelText('Bucket name')).toHaveFocus();
  });

  // The local format check accepts a taken name, so a blur re-running it must not clear
  // what the server said.
  it('keeps the taken-name error when the name field loses focus unchanged', async () => {
    mockApiRequest.mockRejectedValue(takenNameError);
    renderPage();
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: BUCKET } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));
    await screen.findByText('This name is already taken. Try another.');

    fireEvent.blur(screen.getByLabelText('Bucket name'));

    expect(screen.getByText('This name is already taken. Try another.')).toBeInTheDocument();
  });

  it('shows the taken-name error again when the name is edited back to the taken one', async () => {
    mockApiRequest.mockRejectedValue(takenNameError);
    renderPage();
    const field = screen.getByLabelText('Bucket name');
    fireEvent.change(field, { target: { value: BUCKET } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));
    await screen.findByText('This name is already taken. Try another.');
    fireEvent.change(field, { target: { value: 'any-other-name' } });

    fireEvent.change(field, { target: { value: BUCKET } });

    expect(screen.getByText('This name is already taken. Try another.')).toBeInTheDocument();
  });

  // Names are unique within a region, so a name taken in one may be free in another.
  it('clears the taken-name error when another region is picked', async () => {
    mockApiRequest.mockRejectedValue(takenNameError);
    renderPage();
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: BUCKET } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));
    await screen.findByText('This name is already taken. Try another.');

    fireEvent.click(screen.getByRole('button', { name: /^Region/ }));
    const otherRegion = (await screen.findAllByRole('option')).find(
      (option) => option.getAttribute('aria-selected') === 'false',
    );
    fireEvent.click(otherRegion!);

    expect(screen.queryByText('This name is already taken. Try another.')).not.toBeInTheDocument();
  });

  it('shows the taken-name error again when the region that refused the name is picked back', async () => {
    mockApiRequest.mockRejectedValue(takenNameError);
    renderPage();
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: BUCKET } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));
    await screen.findByText('This name is already taken. Try another.');

    fireEvent.click(screen.getByRole('button', { name: /^Region/ }));
    const options = await screen.findAllByRole('option');
    const refusingRegion = options.find(
      (option) => option.getAttribute('aria-selected') === 'true',
    );
    const otherRegion = options.find((option) => option.getAttribute('aria-selected') === 'false');
    fireEvent.click(otherRegion!);
    fireEvent.click(screen.getByRole('button', { name: /^Region/ }));
    fireEvent.click(
      (await screen.findAllByRole('option')).find(
        (option) => option.dataset.region === refusingRegion!.dataset.region,
      )!,
    );

    expect(screen.getByText('This name is already taken. Try another.')).toBeInTheDocument();
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
  it('asks for a name under the field when Create bucket is pressed', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));

    expect(screen.getByText('Enter a bucket name.')).toBeInTheDocument();
  });

  it('puts the cursor in the name field when Create bucket is pressed', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));

    expect(screen.getByLabelText('Bucket name')).toHaveFocus();
  });

  it('sends no create request when Create bucket is pressed', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));

    expect(mockApiRequest).not.toHaveBeenCalled();
  });
});

describe('CreateBucketPage — a name the format check refuses', () => {
  it('puts the cursor back in the name field when Create bucket is pressed', () => {
    renderPage();
    // Two characters, under the three the format allows.
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: 'ab' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));

    expect(screen.getByLabelText('Bucket name')).toHaveFocus();
  });
});

describe('CreateBucketPage — while the bucket is being created', () => {
  beforeEach(() => {
    mockApiRequest.mockReturnValue(new Promise(() => {}));
  });

  it('keeps the name read-only', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: BUCKET } });

    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));

    expect(screen.getByLabelText('Bucket name')).toHaveAttribute('readonly');
  });

  it('disables the region picker', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: BUCKET } });

    fireEvent.click(screen.getByRole('button', { name: 'Create bucket' }));

    expect(screen.getByRole('button', { name: /^Region/ })).toBeDisabled();
  });
});
