import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode, S3Region } from '@filone/shared';
import type { ListBucketsResponse } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { BucketsPage } from './BucketsPage.js';

// ---------------------------------------------------------------------------
// Mocks — API client boundary + router
// ---------------------------------------------------------------------------

const mockApiRequest = vi.fn();

vi.mock('../lib/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

vi.mock('@tanstack/react-router', () => ({
  // `params`/`search` are router-only props — dropping them keeps them off the DOM.
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const BUCKETS: ListBucketsResponse = {
  buckets: [
    {
      bucketName: 'my-bucket',
      region: S3Region.EuWest1,
      createdAt: '2026-07-01T00:00:00Z',
      isPublic: false,
      versioning: false,
      objectLockEnabled: false,
    },
  ],
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <BucketsPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// Resolves once the bucket list has rendered, so the delete button is present.
async function renderPageWithBuckets() {
  mockApiRequest.mockResolvedValue(BUCKETS);
  renderPage();
  return screen.findByRole('button', { name: 'Delete bucket my-bucket' });
}

function rejectDeleteWith(error: Error) {
  mockApiRequest.mockImplementation((path: string, options?: { method?: string }) =>
    options?.method === 'DELETE' ? Promise.reject(error) : Promise.resolve(BUCKETS),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BucketsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Deleting a bucket is irreversible, so the trash icon must not delete on click.
  it('asks for confirmation before deleting and does not call the API', async () => {
    const deleteButton = await renderPageWithBuckets();
    mockApiRequest.mockClear();

    fireEvent.click(deleteButton);

    expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it('deletes the bucket once the dialog is confirmed', async () => {
    const deleteButton = await renderPageWithBuckets();
    fireEvent.click(deleteButton);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete bucket' }));

    await waitFor(() =>
      expect(mockApiRequest).toHaveBeenCalledWith('/buckets/my-bucket', { method: 'DELETE' }),
    );
    expect(await screen.findByText('Bucket "my-bucket" deleted')).toBeInTheDocument();
  });

  // A full bucket is user-fixable, so the error explains what to do and links the docs
  // instead of passing the raw API message through.
  it('explains how to empty the bucket when the API returns BUCKET_NOT_EMPTY', async () => {
    const deleteButton = await renderPageWithBuckets();
    rejectDeleteWith(
      Object.assign(new Error('Bucket "my-bucket" is not empty.'), {
        status: 409,
        code: ApiErrorCode.BUCKET_NOT_EMPTY,
      }),
    );

    fireEvent.click(deleteButton);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete bucket' }));

    expect(await screen.findByText(/is not empty/)).toBeInTheDocument();
    expect(screen.getByText(/Delete its objects and object versions first/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /how to empty a bucket/ })).toHaveAttribute(
      'href',
      'https://docs.fil.one/storage/objects#deleting-objects',
    );
  });

  it('surfaces the API message for other delete failures', async () => {
    const deleteButton = await renderPageWithBuckets();
    rejectDeleteWith(Object.assign(new Error('Tenant setup is not complete'), { status: 503 }));

    fireEvent.click(deleteButton);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete bucket' }));

    expect(await screen.findByText('Tenant setup is not complete')).toBeInTheDocument();
  });
});
