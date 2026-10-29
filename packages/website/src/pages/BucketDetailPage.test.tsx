import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  OrgRole,
  POLICY_VERSION,
  PlanId,
  S3Region,
  SubscriptionStatus,
  buildStatement,
} from '@filone/shared';

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

vi.mock('../lib/api.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/api.js')>('../lib/api.js')),
  apiRequest: (...a: unknown[]) => mockApiRequest(...a),
  // Each row's Share control reads the plan; a never-settling read leaves it at
  // its "not known yet" state, which is not what these tests are about.
  getBilling: () => mockGetBilling(),
  // Permissions come seeded; only the test about loading them leaves /me to this.
  getMe: () => mockGetMe(),
}));

const mockGetBilling = vi.fn(() => new Promise(() => {}));
const mockGetMe = vi.fn(() => new Promise(() => {}));

// One object by default, so the table renders a row with its per-row controls
// and the header actions the empty bucket would otherwise hide from everybody.
const ONE_OBJECT_LISTING = {
  objects: [{ key: OBJECT_KEY, sizeBytes: 12, lastModified: '2026-01-01T00:00:00Z' }],
  isTruncated: false,
};
const mockParseListObjects = vi.fn(() => ONE_OBJECT_LISTING);

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
    generatePresignedUrl: vi.fn(),
    generatingUrl: false,
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

// The policy tab exists only on a region serving the `iam` access model; the
// suite about it flips this on, every other suite runs against `service-keys`.
const mockSupportsIamMethods = vi.fn(() => false);
vi.mock('../lib/access-model.js', () => ({ supportsIamMethods: () => mockSupportsIamMethods() }));

vi.mock('../lib/use-presign.js', () => ({
  batchPresign: () => Promise.resolve({ items: [{ url: 'https://s3.test/list', method: 'GET' }] }),
}));

vi.mock('../lib/aurora-s3.js', () => ({
  executePresignedUrl: () =>
    Promise.resolve({ text: () => Promise.resolve('<ListBucketResult/>') }),
  parseListObjectVersionsResponse: () => ({ versions: [], isTruncated: false }),
  parseListObjectsResponse: () => mockParseListObjects(),
}));

import { BucketDetailPage } from './BucketDetailPage.js';

const USER_1 = '00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUCKET = 'my-bucket';
const REGION = S3Region.EuWest1;

const ACCESS_KEY = {
  id: 'key-1',
  type: 'service',
  keyName: 'ci key',
  accessKeyId: 'AKIAOWN',
  createdAt: '2026-01-01T00:00:00Z',
  status: 'active',
  permissions: ['read'],
  bucketScope: 'all',
  region: REGION,
  expiresAt: null,
  createdBy: USER_1,
};

const grantAllActionsToUser1 = {
  policy: {
    Version: POLICY_VERSION,
    Statement: [
      buildStatement({
        bucketName: 'photos',
        principal: ['user-1'],
        actions: ['s3:*'],
        sid: 'team',
      }),
    ],
  },
};

/** The keys that reach the bucket; one by default. */
const mockBucketKeys = vi.fn(() => [ACCESS_KEY]);

/** Route each of the page's reads by its path; the object listing is stubbed out. */
function respond(path: string) {
  if (path.startsWith('/access-keys')) return Promise.resolve({ keys: mockBucketKeys() });
  if (path.includes('/policy')) return Promise.resolve(grantAllActionsToUser1);
  if (path.startsWith('/org/members')) return Promise.resolve({ members: [] });
  if (path.includes('/analytics')) {
    return Promise.resolve({ objectCount: 0, bytesUsed: 0 });
  }
  return Promise.resolve({
    bucket: { bucketName: BUCKET, region: REGION, createdAt: '2026-01-01T00:00:00Z' },
  });
}

function renderPage(
  role: OrgRole = OrgRole.Owner,
  { arePermissionsKnown = true }: { arePermissionsKnown?: boolean } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (arePermissionsKnown) seedPermissions(client, role);
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
  mockSupportsIamMethods.mockReturnValue(false);
  mockParseListObjects.mockReturnValue(ONE_OBJECT_LISTING);
  mockBucketKeys.mockReturnValue([ACCESS_KEY]);
  mockApiRequest.mockImplementation((path: string) => respond(path));
});

describe('BucketDetailPage — the policy tab', () => {
  it.each([OrgRole.Owner, OrgRole.Admin])(
    'shows the Policy tab to %s on an iam region',
    async (role) => {
      mockSupportsIamMethods.mockReturnValue(true);
      renderPage(role);

      expect(await screen.findByTestId('bucket-policy-tab')).toBeInTheDocument();
    },
  );

  it("renders the bucket's policy in the Policy tab", async () => {
    mockSupportsIamMethods.mockReturnValue(true);
    renderPage(OrgRole.Owner);

    fireEvent.click(await screen.findByTestId('bucket-policy-tab'));

    expect(await screen.findByText('team')).toBeInTheDocument();
  });

  it.each([OrgRole.Member, OrgRole.ReadOnly])('hides the Policy tab from %s', async (role) => {
    mockSupportsIamMethods.mockReturnValue(true);
    renderPage(role);

    await screen.findByTestId('bucket-objects-tab');
    expect(screen.queryByTestId('bucket-policy-tab')).not.toBeInTheDocument();
  });

  it('hides the Policy tab on a service-keys region even from an Owner', async () => {
    renderPage(OrgRole.Owner);

    await screen.findByTestId('bucket-objects-tab');
    expect(screen.queryByTestId('bucket-policy-tab')).not.toBeInTheDocument();
  });
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

// A bucket the create form just made opens here, so the empty state carries the
// API key step the form no longer asks about.
describe('BucketDetailPage — an empty bucket', () => {
  beforeEach(() => mockParseListObjects.mockReturnValue({ objects: [], isTruncated: false }));

  it('opens the Add key modal from the empty state when no key reaches the bucket', async () => {
    mockBucketKeys.mockReturnValue([]);
    renderPage(OrgRole.Owner);

    fireEvent.click(await screen.findByRole('button', { name: 'Create API key' }));

    expect(await screen.findByTestId('add-bucket-key-modal')).toBeInTheDocument();
  });

  it('offers Create API key when every key that reaches the bucket has expired', async () => {
    mockBucketKeys.mockReturnValue([{ ...ACCESS_KEY, status: 'expired' }]);
    renderPage(OrgRole.Owner);

    expect(await screen.findByRole('button', { name: 'Create API key' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View API keys' })).not.toBeInTheDocument();
  });

  it('switches to the API Keys tab when keys reach the bucket already', async () => {
    renderPage(OrgRole.Owner);

    fireEvent.click(await screen.findByRole('button', { name: 'View API keys' }));

    expect(screen.getByTestId('bucket-keys-tab')).toHaveAttribute('aria-selected', 'true');
  });

  it('opens no Add key modal from View API keys', async () => {
    renderPage(OrgRole.Owner);

    fireEvent.click(await screen.findByRole('button', { name: 'View API keys' }));

    expect(screen.queryByTestId('add-bucket-key-modal')).not.toBeInTheDocument();
  });

  // A failed list says nothing about whether keys exist, and a new key could duplicate one.
  it('offers no key step when the key list fails to load', async () => {
    mockApiRequest.mockImplementation((path: string) =>
      path.startsWith('/access-keys')
        ? Promise.reject(Object.assign(new Error('Service unavailable'), { status: 503 }))
        : respond(path),
    );
    renderPage(OrgRole.Owner);

    expect(await screen.findByText('This bucket is empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /API key/ })).not.toBeInTheDocument();
  });

  it('keeps the loading placeholder, not the empty state, until permissions load', async () => {
    mockGetMe.mockReturnValue(new Promise(() => {}));
    renderPage(OrgRole.Owner, { arePermissionsKnown: false });

    // The listing has answered once the Objects tab shows its count.
    expect(
      await within(screen.getByTestId('bucket-objects-tab')).findByText('0'),
    ).toBeInTheDocument();

    expect(screen.getByLabelText('Loading objects')).toBeInTheDocument();
  });

  // The button sits in the Objects panel, which the switch replaces.
  it('moves focus onto the API Keys tab after View API keys switches to it', async () => {
    renderPage(OrgRole.Owner);

    fireEvent.click(await screen.findByRole('button', { name: 'View API keys' }));

    await waitFor(() => expect(screen.getByTestId('bucket-keys-tab')).toHaveFocus());
  });

  it('keeps the loading placeholder, not the empty state, until the key list answers', async () => {
    mockApiRequest.mockImplementation((path: string) =>
      // A key list that never answers.
      path.startsWith('/access-keys') ? new Promise(() => {}) : respond(path),
    );
    renderPage(OrgRole.Owner);

    // The listing has answered once the Objects tab shows its count.
    expect(
      await within(screen.getByTestId('bucket-objects-tab')).findByText('0'),
    ).toBeInTheDocument();

    expect(screen.getByLabelText('Loading objects')).toBeInTheDocument();
    expect(screen.queryByText('This bucket is empty')).not.toBeInTheDocument();
  });

  it('offers no Create API key to a role without keys.create', async () => {
    renderPage(OrgRole.ReadOnly);

    expect(await screen.findByText('This bucket is empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create API key' })).not.toBeInTheDocument();
  });
});

describe('BucketDetailPage — sharing from a row', () => {
  // A Member cannot read billing, so the plan is unknown and Share is offered:
  // the presign endpoint applies the plan rule itself.
  it('opens the share dialog for the row it was clicked on', async () => {
    renderPage(OrgRole.Member);

    fireEvent.click(await screen.findByRole('button', { name: `Share ${OBJECT_KEY}` }));

    expect(await screen.findByTestId('share-object-modal')).toBeInTheDocument();
  });

  it('keeps Share visible but disabled while the plan is a trial', async () => {
    mockGetBilling.mockResolvedValueOnce({
      subscription: { planId: PlanId.FreeTrial, status: SubscriptionStatus.Trialing },
    });
    renderPage(OrgRole.Owner);

    const share = await screen.findByRole('button', { name: `Share ${OBJECT_KEY}` });
    await waitFor(() => expect(mockGetBilling).toHaveBeenCalled());
    expect(share).toBeDisabled();
  });

  it('enables Share once the plan is paid', async () => {
    mockGetBilling.mockResolvedValueOnce({
      subscription: { planId: PlanId.PayAsYouGo, status: SubscriptionStatus.Active },
    });
    renderPage(OrgRole.Owner);

    const share = await screen.findByRole('button', { name: `Share ${OBJECT_KEY}` });
    await waitFor(() => expect(share).toBeEnabled());
  });
});
