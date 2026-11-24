import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, PlanId, S3Region, SubscriptionStatus } from '@filone/shared';
import type { S3ObjectVersion } from '@filone/shared';

import { seedPermissions } from '../lib/test-permissions.js';
import { queryClient as pageCacheClient, queryKeys } from '../lib/query-client.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';

// ---------------------------------------------------------------------------
// Mocks: the router, the network, and the object actions. Each test decides
// when presigning settles, and so when the metadata query leaves loading.
// ---------------------------------------------------------------------------

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock('../lib/api.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/api.js')>('../lib/api.js')),
  // A paid plan, so the Share control is enabled.
  getBilling: () =>
    Promise.resolve({
      subscription: { planId: PlanId.PayAsYouGo, status: SubscriptionStatus.Active },
    }),
}));

const mockBatchPresign = vi.fn();
vi.mock('../lib/use-presign.js', () => ({
  batchPresign: (...args: unknown[]) => mockBatchPresign(...args),
}));

vi.mock('../lib/aurora-s3.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/aurora-s3.js')>('../lib/aurora-s3.js')),
  executePresignedUrl: () =>
    Promise.resolve(new Response(null, { headers: { 'content-length': '12' } })),
}));

vi.mock('../lib/use-object-actions.js', () => ({
  useObjectActions: () => ({
    deleteObject: vi.fn(),
    downloadObject: vi.fn(),
  }),
}));

// The share modal reports whether the page asked it to open. Its own body
// presigns a link, which this file is not about.
vi.mock('../components/ShareObjectModal', () => ({
  ShareObjectModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="share-object-modal" /> : null,
}));

import { ObjectDetailPage } from './ObjectDetailPage.js';

const BUCKET = 'any-bucket';
const REGION = S3Region.EuWest1;
const OBJECT_KEY = 'any-key';

const PRESIGNED_HEAD = { items: [{ url: 'https://s3.test/head', method: 'HEAD' }] };

/** A presign call the test settles when it chooses. */
function deferPresign() {
  let resolve!: (value: typeof PRESIGNED_HEAD) => void;
  let reject!: (reason: Error) => void;
  mockBatchPresign.mockReturnValue(
    new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    }),
  );
  return { resolve, reject };
}

/**
 * The page reads whether the bucket locks objects before it presigns the HEAD.
 * Seeded so that lookup settles at once instead of retrying a request the test
 * has no server for.
 */
function seedBucketWithoutObjectLock() {
  pageCacheClient.setQueryData(queryKeys.bucket(BUCKET, REGION), {
    bucket: { bucketName: BUCKET, region: REGION, isPublic: false, objectLockEnabled: false },
  });
}

/**
 * Renders the page for the object, or for the version the URL names. `versions`
 * seeds the object's history, fresh, so the page does not fetch it.
 */
function renderPage(versionId?: string, { versions }: { versions?: S3ObjectVersion[] } = {}) {
  seedBucketWithoutObjectLock();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner);
  if (versions) {
    client.setQueryData(queryKeys.objectVersions(BUCKET, REGION, OBJECT_KEY), versions);
  }
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ObjectDetailPage
          bucketName={BUCKET}
          region={REGION}
          objectKey={OBJECT_KEY}
          versionId={versionId}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// Looked up again once enabled: the header swaps a disabled Share, wrapped in
// its tooltip, for a new element when the plan turns out to allow sharing.
const openShare = async () => {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Share' }));
};
const openDelete = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'More object actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
};

describe('ObjectDetailPage while the metadata loads', () => {
  beforeEach(() => {
    mockBatchPresign.mockReset();
  });

  afterEach(() => {
    pageCacheClient.clear();
  });

  it.each([
    { control: 'Share', open: openShare, dialog: 'share-object-modal' },
    { control: 'Delete', open: openDelete, dialog: 'confirm-dialog' },
  ])('opens the $control dialog from the header', async ({ open, dialog }) => {
    deferPresign();
    renderPage();
    expect(screen.getByRole('status', { name: 'Loading object details' })).toBeInTheDocument();

    await open();

    expect(await screen.findByTestId(dialog)).toBeInTheDocument();
  });

  it.each([
    {
      control: 'Share',
      outcome: 'loads',
      open: openShare,
      dialog: 'share-object-modal',
      settle: (p: ReturnType<typeof deferPresign>) => p.resolve(PRESIGNED_HEAD),
      expectSettled: () => screen.getByRole('heading', { name: 'Details' }),
    },
    {
      control: 'Share',
      outcome: 'fails',
      open: openShare,
      dialog: 'share-object-modal',
      settle: (p: ReturnType<typeof deferPresign>) => p.reject(new Error('any failure')),
      expectSettled: () => screen.getByText('any failure'),
    },
    {
      control: 'Delete',
      outcome: 'loads',
      open: openDelete,
      dialog: 'confirm-dialog',
      settle: (p: ReturnType<typeof deferPresign>) => p.resolve(PRESIGNED_HEAD),
      expectSettled: () => screen.getByRole('heading', { name: 'Details' }),
    },
    {
      control: 'Delete',
      outcome: 'fails',
      open: openDelete,
      dialog: 'confirm-dialog',
      settle: (p: ReturnType<typeof deferPresign>) => p.reject(new Error('any failure')),
      expectSettled: () => screen.getByText('any failure'),
    },
  ])(
    'keeps the $control dialog open when the metadata then $outcome',
    async ({ open, dialog, settle, expectSettled }) => {
      const presign = deferPresign();
      renderPage();
      await open();
      await screen.findByTestId(dialog);

      await act(async () => settle(presign));

      // The page reached the state the case names, not just any state after loading.
      await waitFor(() => expect(expectSettled()).toBeInTheDocument());
      expect(screen.getByTestId(dialog)).toBeInTheDocument();
    },
  );

  it('shows the version history from the bucket listing before the metadata arrives', () => {
    deferPresign();
    pageCacheClient.setQueryData(
      queryKeys.objectsPage({ bucketName: BUCKET, region: REGION, prefix: '', cursor: null }),
      {
        versions: [
          {
            key: OBJECT_KEY,
            versionId: 'any-version-2',
            lastModified: '2026-01-02T00:00:00Z',
            isLatest: true,
          },
          {
            key: OBJECT_KEY,
            versionId: 'any-version-1',
            lastModified: '2026-01-01T00:00:00Z',
            isLatest: false,
          },
        ],
        folders: [],
      },
    );
    renderPage('any-version-1');

    expect(screen.getByRole('status', { name: 'Loading object details' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Version history 2' })).toBeInTheDocument();
  });
});

describe('ObjectDetailPage API example', () => {
  it('shows the API example before the metadata arrives', () => {
    deferPresign();
    renderPage();

    expect(screen.getByRole('status', { name: 'Loading object details' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'API access' })).toBeInTheDocument();
  });
});

describe('ObjectDetailPage when the metadata fails to load', () => {
  it('keeps the object header above the error', async () => {
    mockBatchPresign.mockRejectedValue(new Error('any failure'));
    renderPage();

    expect(await screen.findByText('any failure')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: OBJECT_KEY })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to bucket' })).toBeInTheDocument();
  });

  it('reports one failure when the object and its history both fail to load', async () => {
    mockBatchPresign.mockRejectedValue(new Error('any failure'));
    renderPage();

    expect(await screen.findByText('any failure')).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load version history. Reload the page to try again.'),
    ).not.toBeInTheDocument();
  });

  it.each(['Download', 'Share', 'More object actions'])(
    'hides the %s button, since the object may no longer exist',
    async (action) => {
      mockBatchPresign.mockRejectedValue(new Error('any failure'));
      renderPage();

      expect(await screen.findByText('any failure')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument();
    },
  );
});

/** One entry of the object's history; only what the case names matters. */
function historyEntry(overrides: Partial<S3ObjectVersion>): S3ObjectVersion {
  return {
    key: OBJECT_KEY,
    versionId: 'any-version',
    sizeBytes: 1,
    lastModified: '2026-01-01T00:00:00Z',
    isLatest: false,
    isDeleteMarker: false,
    ...overrides,
  };
}

describe('ObjectDetailPage when the history says the object is gone', () => {
  const marker = historyEntry({ versionId: 'v-marker', isLatest: true, isDeleteMarker: true });
  const older = historyEntry({ versionId: 'v-older', lastModified: '2025-12-01T00:00:00Z' });

  beforeEach(() => {
    // The HEAD fails as it does on a delete marker; the status differs by provider.
    mockBatchPresign.mockReset();
    mockBatchPresign.mockRejectedValue(new Error('S3 request failed with status 405'));
  });

  it('says the object was deleted instead of reporting the failed request', async () => {
    renderPage(undefined, { versions: [marker, older] });

    expect(await screen.findByText('This object was deleted')).toBeInTheDocument();
    expect(screen.queryByText('S3 request failed with status 405')).not.toBeInTheDocument();
  });

  it('keeps the version history of a deleted object, the way back to its versions', async () => {
    renderPage(undefined, { versions: [marker, older] });

    await screen.findByText('This object was deleted');
    expect(screen.getByRole('heading', { name: 'Version history 2' })).toBeInTheDocument();
  });

  it('says no earlier versions are kept when the delete marker is the whole history', async () => {
    renderPage(undefined, { versions: [marker] });

    expect(await screen.findByText('No earlier versions of it are kept.')).toBeInTheDocument();
  });

  it('says a delete marker named in the URL has no content', async () => {
    const olderMarker = historyEntry({ versionId: 'v-older-marker', isDeleteMarker: true });
    renderPage('v-older-marker', {
      versions: [historyEntry({ versionId: 'v-latest', isLatest: true }), olderMarker],
    });

    expect(await screen.findByText('This version is a delete marker')).toBeInTheDocument();
  });

  it('says the object was not found when it has no history', async () => {
    renderPage(undefined, { versions: [] });

    expect(await screen.findByText('Object not found')).toBeInTheDocument();
  });

  it('offers no AWS CLI command for an object that is gone', async () => {
    renderPage(undefined, { versions: [marker, older] });

    await screen.findByText('This object was deleted');
    expect(screen.queryByText('Download with the AWS CLI')).not.toBeInTheDocument();
  });

  it('waits for the history rather than flash the failed request', async () => {
    // The history never settles, so whether the object is gone stays unknown.
    mockBatchPresign.mockImplementation((_region: unknown, ops: { op: string }[]) =>
      ops[0].op === 'listObjectVersions'
        ? new Promise(() => {})
        : Promise.reject(new Error('S3 request failed with status 405')),
    );
    renderPage();

    await waitFor(() => expect(mockBatchPresign).toHaveBeenCalledTimes(2));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getByRole('status', { name: 'Loading object details' })).toBeInTheDocument();
    expect(screen.queryByText('S3 request failed with status 405')).not.toBeInTheDocument();
  });

  it('reports the failed request when the history holds the object', async () => {
    // The latest is a version, so the history gives no reason the HEAD failed.
    renderPage(undefined, { versions: [historyEntry({ isLatest: true }), older] });

    expect(await screen.findByText('S3 request failed with status 405')).toBeInTheDocument();
  });
});

describe('ObjectDetailPage when the version history fails to load', () => {
  beforeEach(() => {
    // The HEAD loads and the history listing fails.
    mockBatchPresign.mockReset();
    mockBatchPresign.mockImplementation((_region: unknown, ops: { op: string }[]) =>
      ops[0].op === 'listObjectVersions'
        ? Promise.reject(new Error('any listing failure'))
        : Promise.resolve(PRESIGNED_HEAD),
    );
  });

  it('says the history failed to load beside the object', async () => {
    renderPage();

    expect(
      await screen.findByText('Failed to load version history. Reload the page to try again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Details' })).toBeInTheDocument();
  });

  it('keeps the Older version line for a version the URL names', async () => {
    renderPage('any-older-version');

    await screen.findByText('Failed to load version history. Reload the page to try again.');
    expect(screen.getByTestId('object-version-line')).toHaveTextContent('Older version');
  });
});
