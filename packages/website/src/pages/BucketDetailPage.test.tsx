import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, S3Region } from '@filone/shared';

import { seedPermissions } from '../lib/test-permissions.js';
import { queryKeys } from '../lib/query-client.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';

// ---------------------------------------------------------------------------
// Mocks — the network boundary, the router, and the panels this file is not
// about (the object browser drags in presigning and S3 XML parsing).
// ---------------------------------------------------------------------------

const mockApiRequest = vi.fn();

vi.mock('../lib/api.js', () => ({
  apiRequest: (...a: unknown[]) => mockApiRequest(...a),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock('../components/ObjectBrowser', () => ({
  ObjectBrowser: () => null,
  countObjects: () => 0,
}));

vi.mock('../lib/use-object-actions.js', () => ({
  useObjectActions: () => ({
    deleteObject: vi.fn(),
    downloadObject: vi.fn(),
    deleting: null,
    downloading: null,
  }),
}));

vi.mock('../lib/use-presign.js', () => ({
  batchPresign: () => Promise.resolve({ items: [{ url: 'https://s3.test/list', method: 'GET' }] }),
}));

vi.mock('../lib/aurora-s3.js', () => ({
  executePresignedUrl: () =>
    Promise.resolve({ text: () => Promise.resolve('<ListBucketResult/>') }),
  parseListObjectVersionsResponse: () => ({ versions: [], isTruncated: false }),
  parseListObjectsResponse: () => ({ objects: [], isTruncated: false }),
}));

import { BucketDetailPage } from './BucketDetailPage.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUCKET = 'my-bucket';
const REGION = S3Region.EuWest1;

const ACCESS_KEY = {
  id: 'key-1',
  keyName: 'ci key',
  accessKeyId: 'AKIAOWN',
  createdAt: '2026-01-01T00:00:00Z',
  status: 'active',
  permissions: ['read'],
  bucketScope: 'all',
  region: REGION,
  expiresAt: null,
  createdBy: 'user-1',
};

/** Route each of the page's reads by its path; the object listing is stubbed out. */
function respond(path: string) {
  if (path.startsWith('/access-keys')) return Promise.resolve({ keys: [ACCESS_KEY] });
  if (path.includes('/analytics')) {
    return Promise.resolve({ objectCount: 0, bytesUsed: 0 });
  }
  return Promise.resolve({
    bucket: { bucketName: BUCKET, region: REGION, createdAt: '2026-01-01T00:00:00Z' },
  });
}

function renderPage(role = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <BucketDetailPage bucketName={BUCKET} region={REGION} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiRequest.mockImplementation((path: string) => respond(path));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BucketDetailPage — the API keys tab', () => {
  it('shows the tab and its count to a role that may list keys', async () => {
    renderPage(OrgRole.Owner);

    expect(await screen.findByTestId('bucket-keys-tab')).toHaveTextContent('API Keys (1)');
  });

  it('is absent for a role without keys.manage_own, and no request is made', async () => {
    renderPage(OrgRole.ReadOnly);

    await screen.findByTestId('bucket-objects-tab');
    expect(screen.queryByTestId('bucket-keys-tab')).not.toBeInTheDocument();
    const paths = mockApiRequest.mock.calls.map((call) => String(call[0]));
    expect(paths.filter((path) => path.startsWith('/access-keys'))).toHaveLength(0);
  });

  it('drops the tab and its rows when the caller loses keys.manage_own mid-session', async () => {
    // Disabling the query does not evict what it already fetched, and the
    // mounted page is a live observer, so the key metadata and the count would
    // stay in the tab until a reload.
    const { client } = renderPage(OrgRole.Owner);
    expect(await screen.findByTestId('bucket-keys-tab')).toHaveTextContent('API Keys (1)');

    // What a /me refetch after a demotion does.
    act(() => seedPermissions(client, OrgRole.ReadOnly));

    await waitFor(() => expect(screen.queryByTestId('bucket-keys-tab')).not.toBeInTheDocument());
    // The cached response is still there — the read is what changed.
    expect(client.getQueryData(queryKeys.bucketAccessKeys(BUCKET, REGION))).toBeDefined();
  });
});
