import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import { seedPermissions } from '../lib/test-permissions.js';
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

const mockListRagApiKeys = vi.fn();

vi.mock('../lib/rag-api-keys-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/rag-api-keys-api.js')>()),
  listRagApiKeys: (...a: unknown[]) => mockListRagApiKeys(...a),
}));

import { RagPipelinePage, enablementPollInterval } from './RagPipelinePage.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ME: MeResponse = {
  orgId: 'org-1',
  orgName: 'Acme',
  slug: 'acme',
  nameConfirmed: true,
  emailVerified: true,
  email: 'user@example.com',
  name: 'User',
  mfaEnrollments: [],
  ragAccess: true,
  orgsBeta: true,
  billingActive: true,
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
    syncState: 'idle',
    filesIndexed: 847,
    indexSize: 210_000_000,
    lastSyncedAt: '2026-06-22T11:59:00Z',
  },
  'research-papers': {
    enabled: true,
    status: 'active',
    syncState: 'idle',
    filesIndexed: 400,
    indexSize: 114_000_000,
    lastSyncedAt: '2026-06-22T11:56:00Z',
  },
  // Disabled bucket — telemetry zeroed, no lastSyncedAt.
  'marketing-assets': { enabled: false, status: 'disabled', filesIndexed: 0, indexSize: 0 },
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The page's own /me fixture, plus the permissions its gated controls read.
  seedPermissions(client, OrgRole.Owner, ME);

  // Org-scoped like every other real route now: the page's query sources link
  // through `$orgSlug`, so that ancestor needs registering too.
  const rootRoute = createRootRoute();
  const orgSlugRoute = createRoute({ getParentRoute: () => rootRoute, path: '$orgSlug' });
  const hostRoute = createRoute({
    getParentRoute: () => orgSlugRoute,
    path: '/host',
    component: () => <RagPipelinePage />,
  });
  const objectsRoute = createRoute({
    getParentRoute: () => orgSlugRoute,
    path: '/buckets/$bucketName/objects',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([orgSlugRoute.addChildren([hostRoute, objectsRoute])]),
    history: createMemoryHistory({ initialEntries: ['/acme/host'] }),
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
  mockListRagApiKeys.mockResolvedValue({ keys: [] });
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

  it('surfaces the indexer sync state (syncing + error) while keeping the buckets enabled', async () => {
    // Both buckets remain enabled (status active); only their syncState differs.
    // The UI shows the indicators WITHOUT treating them as disabled/unqueryable.
    mockGetEnabled.mockImplementation(async (name: string) => {
      if (name === 'my-docs-bucket') {
        return {
          enabled: true,
          status: 'active',
          syncState: 'syncing',
          filesIndexed: 0,
          indexSize: 0,
        };
      }
      if (name === 'research-papers') {
        return {
          enabled: true,
          status: 'active',
          syncState: 'error',
          filesIndexed: 0,
          indexSize: 0,
          lastSyncError: 'Connection timeout',
        };
      }
      return ENABLEMENT[name];
    });

    renderPage();

    // Status now reads off the badge; the description carries only the detail.
    const badges = await screen.findAllByTestId('bucket-status');
    const states = badges.map((b) => b.getAttribute('data-sync-state'));
    expect(states).toContain('syncing');
    expect(states).toContain('error');
    expect(screen.getByText(/Connection timeout/)).toBeInTheDocument();
    // Sync state must not flip enablement: both rows keep the drawer action and
    // neither falls back to the "Index" (enable) button. Neither has a completed
    // pass, so the action reads "View details" rather than offering asking.
    expect(screen.getAllByTestId('bucket-row-ask')).toHaveLength(2);
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
    // Confirm modal opens naming the bucket, and shows no pricing.
    expect(await screen.findByText('Index this bucket?')).toBeInTheDocument();
    expect(screen.getByText(/“marketing-assets” become queryable/)).toBeInTheDocument();
    expect(screen.queryByText(/\$15/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start indexing' }));

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
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Stop indexing' }));

    // Confirm modal opens; confirm stopping.
    expect(await screen.findByText('Stop indexing this bucket?')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop indexing' }));

    await waitFor(() =>
      expect(mockSetEnabled).toHaveBeenCalledWith('my-docs-bucket', 'us-east-1', false),
    );
  });
});

// ---------------------------------------------------------------------------
// Managed models: reference block in Integrate, not a configuration tab
// ---------------------------------------------------------------------------

describe('RagPipelinePage: managed models', () => {
  it('names both managed models read-only under API Keys, with no BYO inputs', async () => {
    renderPage();
    await screen.findByText('my-docs-bucket');

    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }));

    const models = await screen.findByTestId('api-models');
    expect(within(models).getByText('Titan Text Embeddings V2')).toBeInTheDocument();
    expect(within(models).getByText('Claude Opus 4.8')).toBeInTheDocument();
    expect(screen.getByText(/bring-your-own-model support is coming soon/i)).toBeInTheDocument();

    // No BYO credential entry and no provider/model dropdowns.
    expect(screen.queryByPlaceholderText(/sk-/)).not.toBeInTheDocument();
    expect(screen.queryByText('API Key')).not.toBeInTheDocument();
    expect(screen.queryByText('Provider')).not.toBeInTheDocument();
  });

  it('does not offer a Models tab, since nothing there was configurable', async () => {
    renderPage();
    await screen.findByText('my-docs-bucket');

    expect(screen.queryByRole('tab', { name: 'Models' })).not.toBeInTheDocument();
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
// API reference — endpoint shape lives with the keys, MCP placeholder is gone
// ---------------------------------------------------------------------------

describe('RagPipelinePage — API reference', () => {
  it('shows the endpoint shape under API Keys and no separate API tab', async () => {
    renderPage();
    await screen.findByText('my-docs-bucket');

    // The tab strip is Buckets + API Keys only.
    expect(screen.queryByRole('tab', { name: 'Integrate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'API' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }));

    expect(await screen.findByTestId('api-reference')).toBeInTheDocument();
    // Full-URL curl sample with bearer auth (jsdom origin = http://localhost:3000).
    expect(
      screen.getByText(/curl -X POST "http:\/\/localhost:3000\/api\/buckets\/.+\/query\?region=/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Authorization: Bearer \$FILONE_RAG_KEY/)).toBeInTheDocument();

    // The MCP endpoint is not built, so it is no longer advertised.
    expect(screen.queryByText('MCP endpoint')).not.toBeInTheDocument();
    expect(screen.queryByText('Coming later')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// API Keys tab
// ---------------------------------------------------------------------------

describe('RagPipelinePage — API Keys tab', () => {
  it('renders the tab and mounts the keys panel', async () => {
    renderPage();
    await screen.findByText('my-docs-bucket');

    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }));

    expect(await screen.findByTestId('rag-api-keys-tab')).toBeInTheDocument();
    expect(mockListRagApiKeys).toHaveBeenCalled();
    expect(await screen.findByTestId('rag-api-keys-empty')).toBeInTheDocument();
  });

  it('shows the API key count in the stats grid instead of pricing', async () => {
    mockListRagApiKeys.mockResolvedValue({
      keys: [
        { id: 'k1', keyName: 'a', keyPrefix: 'sk_rag_a', bucketScope: 'all', createdAt: '' },
        { id: 'k2', keyName: 'b', keyPrefix: 'sk_rag_b', bucketScope: 'all', createdAt: '' },
      ],
    });
    renderPage();
    await screen.findByText('my-docs-bucket');

    const stats = screen.getByTestId('rag-pipeline-stats');
    expect(await within(stats).findByText('API keys')).toBeInTheDocument();
    expect(within(stats).getByText('2')).toBeInTheDocument();
    expect(within(stats).queryByText('Pricing')).not.toBeInTheDocument();
    expect(within(stats).queryByText(/\$15/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Access gating — page guards itself
// ---------------------------------------------------------------------------

describe('RagPipelinePage — access gate', () => {
  it('renders a not-available state when the user lacks RAG access', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // One write, not two: the seed and this line target the same cache key, so
    // the seed was overwritten before anything read it.
    seedPermissions(client, OrgRole.Owner, { ...ME, ragAccess: false });

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
      await screen.findByText('Bucket Intelligence is not available for your account.'),
    ).toBeInTheDocument();
    expect(mockListBuckets).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Enablement polling (the indexer writes state out of band)
// ---------------------------------------------------------------------------

describe('enablementPollInterval', () => {
  function interval(data?: Partial<BucketRagEnablementResponse>): number | false {
    return enablementPollInterval({
      state: { data: data as BucketRagEnablementResponse | undefined },
    });
  }

  it('does not poll before the first response lands', () => {
    expect(interval(undefined)).toBe(false);
  });

  it('does not poll a bucket that is not enabled, since nothing will change on its own', () => {
    expect(interval({ enabled: false })).toBe(false);
  });

  it('polls quickly while a pass is in flight', () => {
    expect(interval({ enabled: true, syncState: 'syncing' })).toBe(30_000);
  });

  it('polls slowly while waiting on the first pass, which can take hours', () => {
    expect(interval({ enabled: true, syncState: 'idle' })).toBe(120_000);
  });

  it('keeps polling after a failed pass, since the orchestrator retries on its own', () => {
    // Without this the row stays on "Failed" until a manual reload, even after a
    // later run succeeds.
    expect(
      interval({ enabled: true, syncState: 'error', lastSyncedAt: '2026-01-01T00:00:00Z' }),
    ).toBe(120_000);
  });

  it('stops polling once a bucket is settled and healthy', () => {
    expect(
      interval({ enabled: true, syncState: 'idle', lastSyncedAt: '2026-01-01T00:00:00Z' }),
    ).toBe(false);
  });
});
