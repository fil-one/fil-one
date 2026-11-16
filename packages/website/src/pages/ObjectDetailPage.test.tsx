import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, PlanId, S3Region, SubscriptionStatus } from '@filone/shared';

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
  batchPresign: () => mockBatchPresign(),
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

function renderPage(versionId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner);
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

const openShare = async () => {
  const share = screen.getByRole('button', { name: 'Share object' });
  await waitFor(() => expect(share).toBeEnabled());
  fireEvent.click(share);
};
const openDelete = () => fireEvent.click(screen.getByRole('button', { name: 'Delete object' }));

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
      expectSettled: () => screen.getByRole('heading', { name: 'Object details' }),
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
      expectSettled: () => screen.getByRole('heading', { name: 'Object details' }),
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
    pageCacheClient.setQueryData(queryKeys.objects(BUCKET, REGION), {
      versions: [
        { key: OBJECT_KEY, versionId: 'any-version-1', lastModified: '2026-01-01T00:00:00Z' },
        { key: OBJECT_KEY, versionId: 'any-version-2', lastModified: '2026-01-02T00:00:00Z' },
      ],
    });
    renderPage('any-version-1');

    expect(screen.getByRole('status', { name: 'Loading object details' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Version history (2)' })).toBeInTheDocument();
  });
});

describe('ObjectDetailPage API example', () => {
  it('shows the API example before the metadata arrives', () => {
    deferPresign();
    renderPage();

    expect(screen.getByRole('status', { name: 'Loading object details' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'API access example' })).toBeInTheDocument();
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

  it.each(['Download object', 'Share object', 'Delete object'])(
    'hides the %s action, since the object may no longer exist',
    async (action) => {
      mockBatchPresign.mockRejectedValue(new Error('any failure'));
      renderPage();

      expect(await screen.findByText('any failure')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument();
    },
  );
});
