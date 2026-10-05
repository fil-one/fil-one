import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, S3Region } from '@filone/shared';

import { seedPermissions } from '../lib/test-permissions.js';
import { queryKeys } from '../lib/query-client.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';

// ---------------------------------------------------------------------------
// Mocks — the network boundary, the router, and the two modules the object
// browser reaches the network through (presigning and S3 XML parsing). The
// browser itself renders for real: which of its controls a role gets is what
// half of this file is about.
// ---------------------------------------------------------------------------

const mockApiRequest = vi.fn();

/** The single object the listing returns; hoisted so a mock factory can name it. */
const { OBJECT_KEY } = vi.hoisted(() => ({ OBJECT_KEY: 'README.md' }));

vi.mock('../lib/api.js', () => ({
  apiRequest: (...a: unknown[]) => mockApiRequest(...a),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock('../lib/use-object-actions.js', () => ({
  useObjectActions: () => ({
    deleteObject: vi.fn(),
    deleteObjects: vi.fn(),
    downloadObject: vi.fn(),
    deleting: null,
    downloading: null,
  }),
}));

// The Add key modal reports whether the page asked it to open, which is what
// the permission gate on its state decides. Its own body is a form this file is
// not about.
vi.mock('../components/AddBucketKeyModal', () => ({
  AddBucketKeyModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-bucket-key-modal" /> : null,
}));

vi.mock('../lib/use-presign.js', () => ({
  batchPresign: () => Promise.resolve({ items: [{ url: 'https://s3.test/list', method: 'GET' }] }),
}));

vi.mock('../lib/aurora-s3.js', () => ({
  executePresignedUrl: () =>
    Promise.resolve({ text: () => Promise.resolve('<ListBucketResult/>') }),
  parseListObjectVersionsResponse: () => ({ versions: [], isTruncated: false }),
  // One object, so the table renders a row with its per-row controls and the
  // header actions the empty bucket would otherwise hide from everybody.
  parseListObjectsResponse: () => ({
    objects: [{ key: OBJECT_KEY, sizeBytes: 12, lastModified: '2026-01-01T00:00:00Z' }],
    isTruncated: false,
  }),
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

function renderPage(role: OrgRole = OrgRole.Owner) {
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

    // The tab mounts with the rest of the shell, before the keys land, so the
    // count is what to wait on rather than the tab itself.
    await waitFor(() =>
      expect(screen.getByTestId('bucket-keys-tab')).toHaveTextContent('API Keys1'),
    );
  });

  it('is absent for a role without keys.manage_own, and no request is made', async () => {
    renderPage(OrgRole.ReadOnly);

    await screen.findByTestId('bucket-objects-tab');
    expect(screen.queryByTestId('bucket-keys-tab')).not.toBeInTheDocument();
    const paths = mockApiRequest.mock.calls.map((call) => String(call[0]));
    expect(paths.filter((path) => path.startsWith('/access-keys'))).toHaveLength(0);
  });

  // The modal is a sibling of the tabs, so removing the tab leaves it on
  // screen: an open Add key form is state the caller chose before the
  // demotion, and its submit is the `keys.create` request the hidden Add key
  // button exists to avoid.
  it('closes an open Add key modal when the caller loses keys.create', async () => {
    const { client } = renderPage(OrgRole.Owner);

    fireEvent.click(await screen.findByTestId('bucket-keys-tab'));
    fireEvent.click(await screen.findByRole('button', { name: 'Add key' }));
    expect(await screen.findByTestId('add-bucket-key-modal')).toBeInTheDocument();

    // What a /me refetch after a demotion does.
    act(() => seedPermissions(client, OrgRole.ReadOnly));

    await waitFor(() =>
      expect(screen.queryByTestId('add-bucket-key-modal')).not.toBeInTheDocument(),
    );
  });

  it('drops the tab and its rows when the caller loses keys.manage_own mid-session', async () => {
    // Disabling the query does not evict what it already fetched, and the
    // mounted page is a live observer, so the key metadata and the count would
    // stay in the tab until a reload.
    const { client } = renderPage(OrgRole.Owner);
    // The tab mounts with the rest of the shell, before the keys land, so the
    // count is what to wait on rather than the tab itself.
    await waitFor(() =>
      expect(screen.getByTestId('bucket-keys-tab')).toHaveTextContent('API Keys1'),
    );

    // What a /me refetch after a demotion does.
    act(() => seedPermissions(client, OrgRole.ReadOnly));

    await waitFor(() => expect(screen.queryByTestId('bucket-keys-tab')).not.toBeInTheDocument());
    // The cached response is still there — the read is what changed.
    expect(client.getQueryData(queryKeys.bucketAccessKeys(BUCKET, REGION))).toBeDefined();
  });
});

// FIL-1078 fixed this for the list pages; opening a bucket kept the old
// behaviour, returning a centered spinner in front of the whole page.
describe('BucketDetailPage — loading', () => {
  it('keeps the page shell up while the listing loads, and never blanks it', async () => {
    // The bucket metadata never resolves. The listing is gated on it, so both
    // stay pending for the whole test rather than racing the assertions.
    mockApiRequest.mockImplementation((path: string) =>
      path.startsWith('/access-keys') || path.includes('/analytics')
        ? respond(path)
        : new Promise(() => {}),
    );
    renderPage(OrgRole.Owner);

    // The bucket's name comes from the route, so it has no reason to wait on a
    // request, and neither does the way back out.
    expect(await screen.findByRole('heading', { name: BUCKET })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buckets' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading objects' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading bucket details' })).toBeInTheDocument();
    // A count of zero on a bucket whose listing has not arrived is a guess.
    expect(screen.getByTestId('bucket-objects-tab')).toHaveTextContent(/^Objects$/);
    // The placeholder mirrors the real table: column labels are known before any
    // row is, so they are shown rather than pulsed.
    for (const label of ['Name', 'Size', 'Last Modified']) {
      expect(screen.getByRole('columnheader', { name: label })).toBeInTheDocument();
    }
  });

  it('states the object count once the listing has actually arrived', async () => {
    renderPage(OrgRole.Owner);

    await waitFor(() =>
      expect(screen.getByTestId('bucket-objects-tab')).toHaveTextContent('Objects1'),
    );
    expect(screen.queryByRole('status', { name: 'Loading objects' })).not.toBeInTheDocument();
  });
});

describe('BucketDetailPage — the object controls', () => {
  it('gives an Owner upload, row delete, and both routes to a bulk delete', async () => {
    renderPage(OrgRole.Owner);

    expect(await screen.findByTestId('object-row')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload object' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Delete ${OBJECT_KEY}` })).toBeInTheDocument();
    // The server-side job, which empties the whole bucket rather than a selection.
    expect(screen.getByRole('button', { name: 'Empty bucket' })).toBeInTheDocument();

    // Selecting a row is the only way to the bulk bar, so it stands in for both.
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${OBJECT_KEY}` }));

    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('offers no upload to a role without objects.write', async () => {
    renderPage(OrgRole.ReadOnly);

    expect(await screen.findByTestId('object-row')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload object' })).not.toBeInTheDocument();
  });

  // Row delete, selection, and the empty-bucket job are one permission, so a
  // role without it gets none of the three rather than a checkbox that leads to
  // a 403.
  it('offers no delete of any kind to a role without objects.delete', async () => {
    renderPage(OrgRole.ReadOnly);

    expect(await screen.findByTestId('object-row')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Delete ${OBJECT_KEY}` })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Empty bucket' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});
