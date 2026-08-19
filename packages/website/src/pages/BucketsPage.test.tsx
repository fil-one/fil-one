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
    },
  ],
};

// The row's storage line reads this endpoint independently of the bucket list.
const EMPTY_ANALYTICS = { bytesUsed: 0, objectCount: 0 };

function mockApiResponses(deleteError?: Error) {
  mockApiRequest.mockImplementation((path: string, options?: { method?: string }) => {
    if (options?.method === 'DELETE') {
      return deleteError ? Promise.reject(deleteError) : Promise.resolve(undefined);
    }
    if (path.includes('/analytics')) return Promise.resolve(EMPTY_ANALYTICS);
    return Promise.resolve(BUCKETS);
  });
}

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

// Resolves once the bucket list has rendered and its action menu is open, so
// the "Delete bucket" menu item is present.
async function renderPageWithBucketMenuOpen() {
  mockApiResponses();
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Bucket actions' }));
  return screen.findByRole('menuitem', { name: 'Delete bucket' });
}

function rejectDeleteWith(error: Error) {
  mockApiResponses(error);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BucketsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Deleting a bucket is irreversible, so the menu item must not delete on click.
  it('asks for confirmation before deleting and does not call the API', async () => {
    const deleteMenuItem = await renderPageWithBucketMenuOpen();
    mockApiRequest.mockClear();

    fireEvent.click(deleteMenuItem);

    expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it('deletes the bucket once the dialog is confirmed', async () => {
    const deleteMenuItem = await renderPageWithBucketMenuOpen();
    fireEvent.click(deleteMenuItem);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete bucket' }));

    await waitFor(() =>
      expect(mockApiRequest).toHaveBeenCalledWith('/buckets/my-bucket', { method: 'DELETE' }),
    );
    expect(await screen.findByText('Bucket "my-bucket" deleted')).toBeInTheDocument();
  });

  // A full bucket is user-fixable, so the error explains what to do and links the docs
  // instead of passing the raw API message through.
  it('explains how to empty the bucket when the API returns BUCKET_NOT_EMPTY', async () => {
    const deleteMenuItem = await renderPageWithBucketMenuOpen();
    rejectDeleteWith(
      Object.assign(new Error('Bucket "my-bucket" is not empty.'), {
        status: 409,
        code: ApiErrorCode.BUCKET_NOT_EMPTY,
      }),
    );

    fireEvent.click(deleteMenuItem);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete bucket' }));

    expect(await screen.findByText(/is not empty/)).toBeInTheDocument();
    expect(screen.getByText(/Delete its objects and object versions first/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /how to empty a bucket/ })).toHaveAttribute(
      'href',
      'https://docs.fil.one/storage/objects#deleting-objects',
    );
  });

  it('surfaces the API message for other delete failures', async () => {
    const deleteMenuItem = await renderPageWithBucketMenuOpen();
    rejectDeleteWith(Object.assign(new Error('Tenant setup is not complete'), { status: 503 }));

    fireEvent.click(deleteMenuItem);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete bucket' }));

    expect(await screen.findByText('Tenant setup is not complete')).toBeInTheDocument();
  });
});
