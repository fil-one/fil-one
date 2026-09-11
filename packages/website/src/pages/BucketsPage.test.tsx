import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode, OrgRole, S3Region } from '@filone/shared';
import type { ListBucketsResponse } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';
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

const DEGRADED: ListBucketsResponse = {
  ...BUCKETS,
  unavailableRegions: [S3Region.UsEast1],
};

const DEGRADED_MESSAGE = 'Cannot list buckets in the us-east-1 region. Please try again later.';

function renderPage(role: OrgRole = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Delete is gated on `buckets.delete`, so the caller's role has to be in the
  // cache before the rows render or the control is absent for the wrong reason.
  seedPermissions(client, role);
  // The client comes back so a test can re-seed it mid-render, which is what a
  // role change under an open dialog looks like.
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <BucketsPage />
        </ToastProvider>
      </QueryClientProvider>,
    ),
  };
}

// Resolves once the bucket list has rendered and its action menu is open, so
// the "Delete bucket" menu item is present.
async function renderPageWithBucketMenuOpen(role: OrgRole = OrgRole.Owner) {
  mockApiResponses();
  renderPage(role);
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

  // Hiding the row's Delete decides only what can be started. The confirmation
  // is state the caller chose before the demotion, and its Delete bucket button
  // would still issue the request the hidden control exists to avoid.
  it('closes an open delete confirmation when the caller loses buckets.delete', async () => {
    mockApiResponses();
    const { client } = renderPage(OrgRole.Owner);
    fireEvent.click(await screen.findByRole('button', { name: 'Bucket actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete bucket' }));
    expect(await screen.findByRole('button', { name: 'Delete bucket' })).toBeInTheDocument();

    // What a /me refetch after a demotion does.
    act(() => seedPermissions(client, OrgRole.Member));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Delete bucket' })).not.toBeInTheDocument(),
    );
  });

  // A Member creates buckets but does not delete them, so the control is absent
  // rather than disabled — the gate is on `buckets.delete` specifically, not on
  // bucket access in general.
  it('gives a Member no delete control', async () => {
    mockApiResponses();
    renderPage(OrgRole.Member);

    fireEvent.click(await screen.findByRole('button', { name: 'Bucket actions' }));

    expect(await screen.findByRole('menuitem', { name: 'Browse objects' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete bucket' })).not.toBeInTheDocument();
  });
});

describe('BucketsPage degraded regions', () => {
  it("banners the failed region and still lists the healthy region's buckets", async () => {
    mockApiRequest.mockResolvedValue(DEGRADED);
    renderPage();

    expect(await screen.findByText(DEGRADED_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText('my-bucket')).toBeInTheDocument();
  });

  it('shows the banner instead of the empty state when no buckets came back', async () => {
    mockApiRequest.mockResolvedValue({ buckets: [], unavailableRegions: [S3Region.UsEast1] });
    renderPage();

    expect(await screen.findByText(DEGRADED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText('No buckets yet')).not.toBeInTheDocument();
  });

  it('shows no banner on a healthy response', async () => {
    mockApiRequest.mockResolvedValue(BUCKETS);
    renderPage();

    await screen.findByText('my-bucket');
    expect(screen.queryByText(/Cannot list buckets/)).not.toBeInTheDocument();
  });

  it('still shows the empty state when a healthy response has no buckets', async () => {
    mockApiRequest.mockResolvedValue({ buckets: [] });
    renderPage();

    expect(await screen.findByText('No buckets yet')).toBeInTheDocument();
  });

  it('surfaces the 503 message when every region is down', async () => {
    mockApiRequest.mockRejectedValue(Object.assign(new Error(DEGRADED_MESSAGE), { status: 503 }));
    renderPage();

    expect(await screen.findByText(DEGRADED_MESSAGE)).toBeInTheDocument();
  });
});
