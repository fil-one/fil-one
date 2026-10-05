import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import type { QueryBucketResponse } from '@filone/shared';
import { OrgRole, S3Region } from '@filone/shared';

const mockQueryBucket = vi.fn();

// Spread the real module: the drawer also imports the pure display-state helpers
// (bucketDisplayState / bucketDotClass) from here, and only the network call
// needs stubbing.
vi.mock('../lib/rag-bucket-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/rag-bucket-api.js')>()),
  queryBucket: (...a: unknown[]) => mockQueryBucket(...a),
}));

import type { RagBucket } from '../lib/rag-bucket-api';
import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from './Toast/ToastProvider.js';
import { BucketDrawer } from './BucketDrawer';

const bucket: RagBucket = {
  name: 'my-docs-bucket',
  region: S3Region.UsEast1,
  enabled: true,
  filesIndexed: 847,
  indexSize: 210_000_000,
  lastSyncedAt: '2026-06-22T11:59:00Z',
};

function renderDrawer(
  onClose: () => void = () => {},
  onStopIndexing: () => void = () => {},
  role: OrgRole = OrgRole.Owner,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Stop indexing is gated on the bucket permissions, so the caller's role has
  // to be in the cache before the drawer renders.
  seedPermissions(client, role);
  const rootRoute = createRootRoute({
    component: () => (
      <ToastProvider>
        <BucketDrawer bucket={bucket} onClose={onClose} onStopIndexing={onStopIndexing} />
      </ToastProvider>
    ),
  });
  const objectsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName/objects',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([objectsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryBucket.mockResolvedValue({
    answer: 'The default retention period is 90 days.',
    sources: ['policies/data-retention.pdf'],
  } satisfies QueryBucketResponse);
});

describe('BucketDrawer', () => {
  it('renders the bucket name and sync telemetry', async () => {
    renderDrawer();
    expect(await screen.findByText('my-docs-bucket')).toBeInTheDocument();
    expect(screen.getByText('847')).toBeInTheDocument();
    expect(screen.getByText('210 MB')).toBeInTheDocument();
  });

  it('disables Ask until the input has text', async () => {
    renderDrawer();
    const ask = await screen.findByRole('button', { name: 'Ask' });
    expect(ask).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Ask about my-docs-bucket…'), {
      target: { value: 'hi' },
    });
    expect(ask).toBeEnabled();
  });

  it('queries with the bucket name + region and renders the grounded answer', async () => {
    renderDrawer();
    fireEvent.change(await screen.findByPlaceholderText('Ask about my-docs-bucket…'), {
      target: { value: 'What is the retention period?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() =>
      expect(mockQueryBucket).toHaveBeenCalledWith(
        'my-docs-bucket',
        'us-east-1',
        'What is the retention period?',
      ),
    );
    expect(await screen.findByText(/default retention period is 90 days/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'data-retention.pdf' })).toBeInTheDocument();
  });

  it('renders an error when the query fails', async () => {
    mockQueryBucket.mockRejectedValue(new Error('Query failed'));
    renderDrawer();
    fireEvent.change(await screen.findByPlaceholderText('Ask about my-docs-bucket…'), {
      target: { value: 'anything' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('Query failed')).toBeInTheDocument();
  });

  it('calls onClose after the close animation', async () => {
    const onClose = vi.fn();
    renderDrawer(onClose);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('offers stop indexing in a footer, away from the Ask action', async () => {
    const onStopIndexing = vi.fn();
    renderDrawer(() => {}, onStopIndexing);

    const stop = await screen.findByTestId('bucket-drawer-stop');
    expect(stop).toHaveTextContent('Stop indexing');
    // Must not sit inside the ask section, where it could be mis-clicked for Ask.
    expect(screen.getByTestId('bucket-drawer-ask')).not.toContainElement(stop);

    fireEvent.click(stop);
    expect(onStopIndexing).toHaveBeenCalledOnce();
  });
});

describe('BucketDrawer — permissions', () => {
  it.each([OrgRole.Member, OrgRole.ReadOnly])(
    'hides stop indexing from %s — that discards the index',
    async (role) => {
      renderDrawer(undefined, undefined, role);

      // The playground itself is theirs; only the footer is not.
      expect(await screen.findByTestId('bucket-drawer-ask')).toBeInTheDocument();
      expect(screen.queryByTestId('bucket-drawer-stop')).not.toBeInTheDocument();
      expect(screen.queryByTestId('bucket-drawer-footer')).not.toBeInTheDocument();
    },
  );

  it('offers stop indexing to an Admin', async () => {
    renderDrawer(undefined, undefined, OrgRole.Admin);

    expect(await screen.findByTestId('bucket-drawer-stop')).toBeInTheDocument();
  });
});
