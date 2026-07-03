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
import { S3Region } from '@filone/shared';

const mockQueryBucket = vi.fn();

vi.mock('../lib/rag-bucket-api.js', () => ({
  queryBucket: (...a: unknown[]) => mockQueryBucket(...a),
}));

import type { RagBucket } from '../lib/rag-bucket-api';
import { BucketDrawer } from './BucketDrawer';

const bucket: RagBucket = {
  name: 'my-docs-bucket',
  region: S3Region.UsEast1,
  enabled: true,
  filesIndexed: 847,
  indexSize: 210_000_000,
  lastSyncedAt: '2026-06-22T11:59:00Z',
};

function renderDrawer(onClose: () => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => <BucketDrawer bucket={bucket} onClose={onClose} />,
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
});
