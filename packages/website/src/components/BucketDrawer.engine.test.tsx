import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { OrgRole, S3Region } from '@filone/shared';

const mockQueryBucket = vi.fn();
const mockGetEngine = vi.fn();
const mockSync = vi.fn();

vi.mock('../lib/rag-bucket-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/rag-bucket-api.js')>()),
  queryBucket: (...a: unknown[]) => mockQueryBucket(...a),
  getBucketRagEngine: (...a: unknown[]) => mockGetEngine(...a),
  syncBucketRag: (...a: unknown[]) => mockSync(...a),
}));

import type { RagBucket } from '../lib/rag-bucket-api';
import {
  QUESTION,
  engineEmpty,
  engineResponse,
  engineSyncing,
  forgeBucket,
  hybridAnswer,
} from '../lib/rag-engine-fixtures.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from './Toast/ToastProvider.js';
import { BucketDrawer } from './BucketDrawer';

function renderDrawer(bucket: RagBucket = forgeBucket, role: OrgRole = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  const rootRoute = createRootRoute({
    component: () => (
      <ToastProvider>
        <BucketDrawer bucket={bucket} onClose={() => {}} onStopIndexing={() => {}} />
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
  mockGetEngine.mockResolvedValue(engineResponse);
  mockQueryBucket.mockResolvedValue(hybridAnswer);
  mockSync.mockResolvedValue(engineSyncing.status);
});

describe('BucketDrawer — Forge (engine-backed) bucket', () => {
  it('reads the engine route for the bucket and shows the Lance dataset', async () => {
    renderDrawer();
    const panel = await screen.findByTestId('rag-dataset-panel');
    expect(mockGetEngine).toHaveBeenCalledWith('acme-handbook', 'eu-central-3');
    expect(within(panel).getByTestId('dataset-uri')).toHaveTextContent(
      's3://filone-rag-3f9a1c07e2b84d5a96c1f0e7d2a4b8c3e5f71d09/lance/chunks.lance',
    );
    expect(within(panel).getByTestId('dataset-rows')).toHaveTextContent('1,912');
    expect(within(panel).getByTestId('dataset-objects')).toHaveTextContent('41');
    expect(within(panel).getByTestId('dataset-version')).toHaveTextContent('v14');
    expect(within(panel).getByTestId('dataset-fragments')).toHaveTextContent('6');
    expect(within(panel).getByTestId('dataset-embedding-model')).toHaveTextContent(
      'BAAI/bge-small-en-v1.5',
    );
    const indexes = within(panel).getAllByTestId('dataset-index');
    expect(indexes.map((i) => i.textContent)).toEqual([
      expect.stringContaining('IVF_PQ'),
      expect.stringContaining('FTS'),
    ]);
    expect(indexes[0]).toHaveTextContent('32 pending');
  });

  it('offers a Python snippet with key placeholders, never keys', async () => {
    renderDrawer();
    const panel = await screen.findByTestId('rag-dataset-panel');
    const code = within(panel).getByText(/lancedb\.connect/);
    expect(code).toHaveTextContent(
      's3://filone-rag-3f9a1c07e2b84d5a96c1f0e7d2a4b8c3e5f71d09/lance',
    );
    expect(code).toHaveTextContent('https://s3.eu-central-3.staging.filonecontent.com');
    expect(code).toHaveTextContent('os.environ["FILONE_SECRET_ACCESS_KEY"]');
  });

  it('sends the chosen search mode and version with the question', async () => {
    renderDrawer();
    fireEvent.click(await screen.findByTestId('search-mode-fulltext'));
    expect(screen.getByTestId('search-mode-fulltext')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByLabelText('Dataset version'), { target: { value: '11' } });
    expect(screen.getByTestId('version-hint')).toHaveTextContent('Searching version 11');

    fireEvent.change(screen.getByPlaceholderText('Ask about acme-handbook…'), {
      target: { value: QUESTION },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() =>
      expect(mockQueryBucket).toHaveBeenCalledWith('acme-handbook', 'eu-central-3', QUESTION, {
        searchMode: 'fulltext',
        version: 11,
      }),
    );
    expect(await screen.findAllByTestId('citation-marker')).toHaveLength(3);
    expect(screen.getByTestId('query-trace')).toBeInTheDocument();
  });

  it('defaults to hybrid on the latest version', async () => {
    renderDrawer();
    fireEvent.change(await screen.findByPlaceholderText('Ask about acme-handbook…'), {
      target: { value: 'q' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() =>
      expect(mockQueryBucket).toHaveBeenCalledWith('acme-handbook', 'eu-central-3', 'q', {
        searchMode: 'hybrid',
        version: undefined,
      }),
    );
  });

  it('lists the dataset versions, newest first, behind Latest', async () => {
    renderDrawer();
    await screen.findByTestId('rag-dataset-panel');
    const options = within(screen.getByLabelText('Dataset version')).getAllByRole('option');
    expect(options[0]).toHaveTextContent('Latest (v14)');
    expect(options[1]).toHaveTextContent('v13');
    expect(options).toHaveLength(14);
    fireEvent.change(screen.getByLabelText('Dataset version'), { target: { value: '11' } });
    expect(screen.getByTestId('version-hint')).toHaveTextContent('(before-retention-update)');
  });

  it('starts a run with Index now and shows its progress', async () => {
    mockGetEngine.mockResolvedValueOnce(engineResponse).mockResolvedValue(engineSyncing);
    renderDrawer();
    fireEvent.click(await screen.findByTestId('rag-engine-sync-button'));

    await waitFor(() => expect(mockSync).toHaveBeenCalledWith('acme-handbook', 'eu-central-3'));
    expect(await screen.findByTestId('rag-engine-sync-progress-label')).toHaveTextContent(
      '17 of 40 objects · 796 chunks written',
    );
    expect(screen.getByRole('progressbar', { name: 'Indexing progress' })).toHaveAttribute(
      'aria-valuenow',
      '43',
    );
    expect(screen.getByTestId('rag-engine-sync-button')).toBeDisabled();
  });

  it('copes with a sync route that answers with no body', async () => {
    mockSync.mockResolvedValue(undefined);
    renderDrawer();
    fireEvent.click(await screen.findByTestId('rag-engine-sync-button'));
    await waitFor(() => expect(mockSync).toHaveBeenCalled());
    await waitFor(() => expect(mockGetEngine.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('makes Index now the primary action before the first run, and keeps asking disabled', async () => {
    mockGetEngine.mockResolvedValue(engineEmpty);
    renderDrawer({ ...forgeBucket, filesIndexed: 0, indexSize: 0, lastSyncedAt: undefined });
    expect(await screen.findByTestId('rag-engine-sync-button')).toHaveTextContent('Index now');
    expect(screen.getByTestId('bucket-drawer-stat-waiting')).toHaveTextContent('Not indexed yet');
    expect(screen.getByTestId('bucket-drawer-not-indexed')).toHaveTextContent('Index now');
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    expect(screen.queryByTestId('rag-dataset-panel')).not.toBeInTheDocument();
  });

  it('hides Index now from a read-only member', async () => {
    renderDrawer(forgeBucket, OrgRole.ReadOnly);
    expect(await screen.findByTestId('rag-dataset-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('rag-engine-sync-button')).not.toBeInTheDocument();
  });
});

describe('BucketDrawer — other regions', () => {
  it('does not call the engine route or show engine controls', async () => {
    renderDrawer({ ...forgeBucket, region: S3Region.UsEast1 });
    fireEvent.change(await screen.findByPlaceholderText('Ask about acme-handbook…'), {
      target: { value: 'q' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() =>
      expect(mockQueryBucket).toHaveBeenCalledWith('acme-handbook', 'us-east-1', 'q'),
    );
    expect(mockGetEngine).not.toHaveBeenCalled();
    expect(screen.queryByTestId('rag-search-controls')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rag-engine-sync')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rag-dataset-panel')).not.toBeInTheDocument();
  });
});
