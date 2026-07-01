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

import type {
  BucketRagEnablementResponse,
  ListBucketsResponse,
  MeResponse,
  QueryBucketResponse,
} from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks — the typed RAG client (network boundary)
// ---------------------------------------------------------------------------

const mockListBuckets = vi.fn();
const mockGetEnabled = vi.fn();
const mockSetEnabled = vi.fn();
const mockQueryBucket = vi.fn();

vi.mock('../lib/rag-bucket-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/rag-bucket-api.js')>()),
  listBucketsForRag: (...a: unknown[]) => mockListBuckets(...a),
  getBucketRagEnabled: (...a: unknown[]) => mockGetEnabled(...a),
  setBucketRagEnabled: (...a: unknown[]) => mockSetEnabled(...a),
  queryBucket: (...a: unknown[]) => mockQueryBucket(...a),
}));

import { RagPipelinePage } from './RagPipelinePage.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { queryKeys } from '../lib/query-client.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ME: MeResponse = {
  orgId: 'org-1',
  orgName: 'Acme',
  emailVerified: true,
  email: 'user@example.com',
  name: 'User',
  mfaEnrollments: [],
  ragAccess: true,
};

const BUCKETS: ListBucketsResponse = {
  buckets: [
    {
      bucketName: 'my-docs-bucket',
      region: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      isPublic: false,
    },
    {
      bucketName: 'research-papers',
      region: 'us-east-1',
      createdAt: '2026-01-02T00:00:00Z',
      isPublic: false,
    },
    {
      bucketName: 'marketing-assets',
      region: 'us-east-1',
      createdAt: '2026-01-03T00:00:00Z',
      isPublic: false,
    },
  ],
};

const ENABLEMENT: Record<string, BucketRagEnablementResponse> = {
  'my-docs-bucket': {
    enabled: true,
    status: 'active',
    filesIndexed: 847,
    indexSize: 210_000_000,
    lastSyncedAt: '2026-06-22T11:59:00Z',
  },
  'research-papers': {
    enabled: true,
    status: 'active',
    filesIndexed: 400,
    indexSize: 114_000_000,
    lastSyncedAt: '2026-06-22T11:56:00Z',
  },
  // Disabled bucket — telemetry zeroed, no lastSyncedAt.
  'marketing-assets': { enabled: false, status: 'disabled', filesIndexed: 0, indexSize: 0 },
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.me, ME);

  const rootRoute = createRootRoute({ component: () => <RagPipelinePage /> });
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
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListBuckets.mockResolvedValue(BUCKETS);
  mockGetEnabled.mockImplementation(async (name: string) => ENABLEMENT[name]);
  mockQueryBucket.mockResolvedValue({
    answer: 'The default retention period is 90 days for standard objects.',
    sources: ['policies/data-retention.pdf', 'governance-whitepaper.pdf'],
  } satisfies QueryBucketResponse);
});

// ---------------------------------------------------------------------------
// Buckets tab — real data + telemetry + toggle
// ---------------------------------------------------------------------------

describe('RagPipelinePage — Buckets tab', () => {
  it('renders real buckets with sync telemetry from the API', async () => {
    renderPage();

    expect(await screen.findByText('my-docs-bucket')).toBeInTheDocument();
    expect(screen.getByText('research-papers')).toBeInTheDocument();
    expect(screen.getByText('marketing-assets')).toBeInTheDocument();

    // Files-indexed + index size telemetry surfaces for an enabled, synced bucket.
    expect(screen.getByText('847')).toBeInTheDocument();
    expect(screen.getByText('210 MB')).toBeInTheDocument();
  });

  it('renders a "Not indexed" state gracefully for a disabled bucket', async () => {
    renderPage();
    await screen.findByText('marketing-assets');
    expect(screen.getByText('Not indexed')).toBeInTheDocument();
  });

  it('enables a disabled bucket via the confirm modal', async () => {
    mockSetEnabled.mockResolvedValue({
      enabled: true,
      status: 'active',
      filesIndexed: 0,
      indexSize: 0,
    });
    renderPage();

    await screen.findByText('marketing-assets');
    // The disabled bucket exposes an "Index" action.
    fireEvent.click(screen.getByRole('button', { name: 'Index' }));

    // Confirm modal opens with pricing + an Enable button.
    expect(await screen.findByText('Enable RAG Pipeline?')).toBeInTheDocument();
    expect(screen.getByText('$15 / TB / month')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() =>
      expect(mockSetEnabled).toHaveBeenCalledWith('marketing-assets', 'us-east-1', true),
    );
  });

  it('disables an enabled bucket via the action menu + confirm modal', async () => {
    mockSetEnabled.mockResolvedValue({
      enabled: false,
      status: 'disabled',
      filesIndexed: 847,
      indexSize: 210_000_000,
    });
    renderPage();

    await screen.findByText('my-docs-bucket');
    // Open the action menu for the first enabled bucket and pick Disable.
    const menus = screen.getAllByRole('button', { name: 'Bucket actions' });
    fireEvent.click(menus[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Disable' }));

    // Confirm modal opens; confirm the disable.
    expect(await screen.findByText('Disable RAG Pipeline?')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));

    await waitFor(() =>
      expect(mockSetEnabled).toHaveBeenCalledWith('my-docs-bucket', 'us-east-1', false),
    );
  });
});

// ---------------------------------------------------------------------------
// Models tab — read-only Fil-One model, no API keys
// ---------------------------------------------------------------------------

describe('RagPipelinePage — Models tab', () => {
  it('shows the Fil One-managed model read-only with no API key input', async () => {
    renderPage();
    await screen.findByText('my-docs-bucket');

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));

    expect(await screen.findByText('Index model')).toBeInTheDocument();
    expect(screen.getByText('Query model')).toBeInTheDocument();
    expect(screen.getAllByText('Fil One-managed model').length).toBeGreaterThan(0);

    // No API-key entry and no provider/model dropdowns.
    expect(screen.queryByPlaceholderText(/sk-/)).not.toBeInTheDocument();
    expect(screen.queryByText('API Key')).not.toBeInTheDocument();
    expect(screen.queryByText('Provider')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Query Playground — POST + answer + sources
// ---------------------------------------------------------------------------

describe('RagPipelinePage — Query Playground', () => {
  it('submits to queryBucket and renders the grounded answer + source links', async () => {
    renderPage();

    await screen.findByText('my-docs-bucket');
    // Open the drawer for the first enabled bucket.
    fireEvent.click(screen.getAllByRole('button', { name: 'Ask questions' })[0]);

    const input = await screen.findByPlaceholderText('Ask about my-docs-bucket…');
    fireEvent.change(input, { target: { value: 'What is the retention period?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() =>
      expect(mockQueryBucket).toHaveBeenCalledWith(
        'my-docs-bucket',
        'us-east-1',
        'What is the retention period?',
      ),
    );

    // The grounded answer renders.
    expect(await screen.findByText(/default retention period is 90 days/)).toBeInTheDocument();

    // Sources render as links into the bucket object viewer.
    const sourceLink = screen.getByRole('link', { name: 'data-retention.pdf' });
    expect(sourceLink.getAttribute('href')).toContain('/buckets/my-docs-bucket/objects');
    expect(sourceLink.getAttribute('href')).toContain('key=policies%2Fdata-retention.pdf');
    expect(sourceLink.getAttribute('href')).toContain('region=us-east-1');
  });

  it('renders an error message when the query fails', async () => {
    mockQueryBucket.mockRejectedValue(new Error('Query failed'));
    renderPage();

    await screen.findByText('my-docs-bucket');
    fireEvent.click(screen.getAllByRole('button', { name: 'Ask questions' })[0]);

    const input = await screen.findByPlaceholderText('Ask about my-docs-bucket…');
    fireEvent.change(input, { target: { value: 'anything' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    expect(await screen.findByText('Query failed')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Integrate tab — REST endpoint + MCP coming later
// ---------------------------------------------------------------------------

describe('RagPipelinePage — Integrate tab', () => {
  it('shows the REST query endpoint and MCP as coming later', async () => {
    renderPage();
    await screen.findByText('my-docs-bucket');

    fireEvent.click(screen.getByRole('tab', { name: 'Integrate' }));

    expect(await screen.findByText('Query API')).toBeInTheDocument();
    expect(screen.getByText(/POST \/api\/buckets\/.+\/query\?region=/)).toBeInTheDocument();

    expect(screen.getByText('MCP endpoint')).toBeInTheDocument();
    expect(screen.getByText('Coming later')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Access gating — page guards itself
// ---------------------------------------------------------------------------

describe('RagPipelinePage — access gate', () => {
  it('renders a not-available state when the user lacks RAG access', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.me, { ...ME, ragAccess: false });

    const rootRoute = createRootRoute({ component: () => <RagPipelinePage /> });
    const router = createRouter({
      routeTree: rootRoute.addChildren([]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });

    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText('RAG Pipeline is not available for your account.'),
    ).toBeInTheDocument();
    expect(mockListBuckets).not.toHaveBeenCalled();
  });
});
