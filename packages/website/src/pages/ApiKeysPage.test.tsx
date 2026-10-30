import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, S3Region } from '@filone/shared';
import type { ServiceAccessKey } from '@filone/shared';

const mockApiRequest = vi.fn();
const mockGetUsage = vi.fn(() => Promise.resolve({ tenantStatus: 'active' }));

vi.mock('../lib/api.js', async () => ({
  // The real helpers (errorStatusOf and the like); only the network calls are faked.
  ...(await vi.importActual<typeof import('../lib/api.js')>('../lib/api.js')),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getMe: vi.fn(() => new Promise(() => {})),
  // `useAccountDisabled` reads /usage. Tests that care about the disabled state
  // seed the query cache instead; this keeps the rest from calling undefined.
  getUsage: () => mockGetUsage(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  // The details drawer links each bucket; a plain anchor stands in for the router's.
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

import { ApiKeysPage } from './ApiKeysPage.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { queryClient as sharedQueryClient, queryKeys } from '../lib/query-client.js';
import { seedPermissions } from '../lib/test-permissions.js';

const USER_1 = '00000000-0000-0000-0000-000000000001';
const USER_2 = '00000000-0000-0000-0000-000000000002';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function key(over: Partial<ServiceAccessKey> = {}): ServiceAccessKey {
  return {
    type: 'service',
    id: 'key-1',
    keyName: 'my key',
    accessKeyId: 'ACCESS_KEY_12345EXAMPL',
    createdAt: '2026-01-15T10:00:00Z',
    status: 'active',
    permissions: ['read', 'list'],
    bucketScope: 'all',
    region: S3Region.UsEast1,
    createdBy: USER_1,
    ...over,
  };
}

function renderPage(
  role: OrgRole = OrgRole.Owner,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  seedPermissions(client, role);
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ApiKeysPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApiKeysPage — a role that cannot list keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiRequest.mockResolvedValue({ keys: [] });
  });

  it('makes no request and keeps the page usable', async () => {
    // ReadOnly holds no `keys.*`. The page used to spin on a request that
    // would 403, hiding the connection reference behind it.
    renderPage(OrgRole.ReadOnly);

    expect(await screen.findByTestId('api-keys-no-access')).toBeInTheDocument();
    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(screen.getByTestId('connection-details-tab')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create new key' })).not.toBeInTheDocument();
  });
});

describe('ApiKeysPage — a mid-session downgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops the key list and its count when the caller loses keys.manage_own', async () => {
    // Disabling a query does not evict what it already fetched, and a mounted
    // page is a live observer, so the names and the tab count would sit above
    // the no-access card until a reload.
    mockApiRequest.mockResolvedValue({ keys: [key()] });
    const { client } = renderPage(OrgRole.Member);

    expect(await screen.findByText('my key')).toBeInTheDocument();
    expect(screen.getByTestId('api-keys-tab')).toHaveTextContent('API keys1');

    // What a /me refetch after a demotion does.
    act(() => seedPermissions(client, OrgRole.ReadOnly));

    await waitFor(() => expect(screen.getByTestId('api-keys-no-access')).toBeInTheDocument());
    expect(screen.queryByText('my key')).not.toBeInTheDocument();
    expect(screen.getByTestId('api-keys-tab')).not.toHaveTextContent('API keys1');
    // The cached response is still there — the read is what changed.
    expect(client.getQueryData(queryKeys.accessKeys)).toBeDefined();
  });
});

describe('ApiKeysPage — a failed list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the tabs and the create action beside the error', async () => {
    mockApiRequest.mockRejectedValue(new Error('Service unavailable'));

    renderPage(OrgRole.Owner);

    expect(await screen.findByText('Service unavailable')).toBeInTheDocument();
    // The error used to replace the whole page, taking the static Connection
    // details tab and the action slot with it.
    expect(screen.getByTestId('connection-details-tab')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create new key' })).toBeInTheDocument();
  });
});

describe('ApiKeysPage — who may revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives a Member the action on their own key and not a colleague’s', async () => {
    mockApiRequest.mockResolvedValue({
      keys: [key(), key({ id: 'key-2', keyName: 'theirs', createdBy: USER_2 })],
    });

    renderPage(OrgRole.Member);

    expect(await screen.findByText('my key')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Actions for / })).toHaveLength(1);
  });

  it('requests the list for a Member — the server narrows it', async () => {
    mockApiRequest.mockResolvedValue({ keys: [key()] });

    renderPage(OrgRole.Member);

    expect(await screen.findByText('my key')).toBeInTheDocument();
    expect(mockApiRequest).toHaveBeenCalledWith('/access-keys');
  });
});

describe('ApiKeysPage: an empty key list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiRequest.mockResolvedValue({ keys: [] });
  });

  it('tells a Member the list holds only the keys they created', async () => {
    renderPage(OrgRole.Member);

    expect(
      await screen.findByText(
        'You can only see the keys you create. Owners and Admins see every key in the organization.',
      ),
    ).toBeInTheDocument();
  });

  it.each([OrgRole.Owner, OrgRole.Admin])(
    'invites an %s to create a key, with no word on whose keys are listed',
    async (role) => {
      renderPage(role);

      expect(
        await screen.findByText(
          'Generate credentials to connect your applications via S3-compatible API',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/You can only see the keys you create/)).not.toBeInTheDocument();
    },
  );
});

describe('ApiKeysPage — a disabled account', () => {
  const CANCELED = 'Your subscription has been canceled. Please reactivate to regain access.';

  it('shows the state alone: no tabs, no Create action', async () => {
    mockGetUsage.mockResolvedValue({ tenantStatus: 'disabled' });
    mockApiRequest.mockRejectedValue(new Error(CANCELED));
    renderPage(OrgRole.Owner);

    expect(await screen.findByText(CANCELED)).toBeInTheDocument();
    // Every key here is refused, and Connection details documents a way in that
    // is not open, so neither tab is offered.
    expect(screen.queryByTestId('api-keys-tab')).not.toBeInTheDocument();
    expect(screen.queryByTestId('connection-details-tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create new key/i })).not.toBeInTheDocument();
  });

  // Narrower than isError on purpose: a transient failure is not a disabled
  // account, and the static tab beside the keys still works.
  it('keeps the tabs when the keys request merely fails', async () => {
    mockGetUsage.mockResolvedValue({ tenantStatus: 'active' });
    mockApiRequest.mockRejectedValue(new Error('Failed to load access keys'));
    renderPage(OrgRole.Owner);

    expect(await screen.findByText('Failed to load access keys')).toBeInTheDocument();
    expect(screen.getByTestId('connection-details-tab')).toBeInTheDocument();
  });
});

describe('ApiKeysPage — rotating a key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsage.mockResolvedValue({ tenantStatus: 'active' });
  });

  /** The list, and a rotation that answers with new credentials. */
  function stubRotation(previousKeyRevoked: boolean) {
    mockApiRequest.mockImplementation((_path: string, init?: { method?: string }) =>
      init?.method === 'POST'
        ? Promise.resolve({
            id: 'key-2',
            keyName: 'my key',
            accessKeyId: 'ACCESS_KEY_NEW999EXAMP',
            secretAccessKey: 'the-new-secret',
            createdAt: '2026-09-11T10:00:00Z',
            previousKeyRevoked,
          })
        : Promise.resolve({ keys: [key()] }),
    );
  }

  /** Open the row menu and press one of its items. */
  async function openRowMenu() {
    fireEvent.click(await screen.findByRole('button', { name: /^Actions for / }));
  }

  it('asks first, then shows the new secret once', async () => {
    stubRotation(true);

    renderPage(OrgRole.Owner);
    await openRowMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rotate' }));

    // Nothing is rotated until the caller confirms: the credential they are
    // using stops working the moment the replacement is issued.
    expect(await screen.findByText('Rotate access key')).toBeInTheDocument();
    expect(mockApiRequest).not.toHaveBeenCalledWith('/access-keys/key-1/rotate', {
      method: 'POST',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }));

    expect(await screen.findByTestId('save-credentials-modal')).toBeInTheDocument();
    expect(screen.getByText('ACCESS_KEY_NEW999EXAMP')).toBeInTheDocument();
    expect(mockApiRequest).toHaveBeenCalledWith('/access-keys/key-1/rotate', { method: 'POST' });
  });

  it('says so when the key it replaced is still live', async () => {
    stubRotation(false);

    renderPage(OrgRole.Owner);
    await openRowMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rotate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate key' }));

    expect(await screen.findByText(/still active/)).toBeInTheDocument();
  });

  it('hides the action on a key the caller could no longer mint', async () => {
    // `PutObjectRetention` needs `privileged.grant`, which only an Owner holds,
    // so an Admin would be refused the replacement. Revoking it is still theirs.
    mockApiRequest.mockResolvedValue({
      keys: [key({ granularPermissions: ['PutObjectRetention'] })],
    });

    renderPage(OrgRole.Admin);
    await openRowMenu();

    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Rotate' })).not.toBeInTheDocument();
  });

  it('hides the action on an expired key', async () => {
    // The rotate route refuses an expired key; the remedy is a new one.
    mockApiRequest.mockResolvedValue({
      keys: [key({ status: 'expired', expiresAt: '2026-06-01' })],
    });

    renderPage(OrgRole.Owner);
    await openRowMenu();

    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Rotate' })).not.toBeInTheDocument();
  });

  it('offers no rotation to a role that cannot create keys', async () => {
    // A Member may revoke their own key; rotating it mints a new one, and this
    // key carries more than a Member can grant.
    mockApiRequest.mockResolvedValue({
      keys: [key({ permissions: ['read', 'list', 'DeleteBucket'] })],
    });

    renderPage(OrgRole.Member);
    await openRowMenu();

    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Rotate' })).not.toBeInTheDocument();
  });
});

describe('ApiKeysPage: searching and filtering keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Five keys, the count at which the search and filters appear.
  const fiveKeys = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((name, index) =>
    key({ id: `key-${index}`, keyName: name, accessKeyId: `ANYACCESSKEYID00000${index}` }),
  );

  const rowNames = () =>
    screen.getAllByTestId('access-key-row').map((row) => row.querySelector('button')?.textContent);

  it('narrows the rows to the keys whose name matches the search', async () => {
    mockApiRequest.mockResolvedValue({ keys: fiveKeys });
    renderPage();
    await screen.findByText('alpha');

    fireEvent.change(screen.getByRole('searchbox', { name: /search keys/i }), {
      target: { value: 'CHAR' },
    });

    expect(rowNames()).toStrictEqual(['charlie']);
  });

  it('offers Clear filters when nothing matches, and Clear filters brings every key back', async () => {
    mockApiRequest.mockResolvedValue({ keys: fiveKeys });
    renderPage();
    await screen.findByText('alpha');

    fireEvent.change(screen.getByRole('searchbox', { name: /search keys/i }), {
      target: { value: 'no-such-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(rowNames()).toStrictEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  });

  it('shows every key again once the filter it set can no longer split the list', async () => {
    const keys = [...fiveKeys, key({ id: 'key-5', keyName: 'foxtrot', status: 'expired' })];
    mockApiRequest.mockResolvedValue({ keys });
    const { client } = renderPage();
    await screen.findByText('alpha');
    fireEvent.change(screen.getByRole('combobox', { name: /filter keys by status/i }), {
      target: { value: 'expired' },
    });
    expect(rowNames()).toStrictEqual(['foxtrot']);

    // The only expired key is deleted elsewhere, so the Status filter hides.
    act(() => {
      client.setQueryData(queryKeys.accessKeys, { keys: fiveKeys });
    });

    await waitFor(() =>
      expect(rowNames()).toStrictEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo']),
    );
  });

  it('clears a filter whose control hid, so it does not come back set', async () => {
    const personal = {
      ...fiveKeys[0],
      id: 'key-p',
      keyName: 'personal',
      type: 'principal' as const,
      principalId: 'any-user',
    };
    mockApiRequest.mockResolvedValue({ keys: [...fiveKeys, personal] });
    const { client } = renderPage();
    await screen.findByText('alpha');
    fireEvent.change(screen.getByRole('combobox', { name: /filter keys by type/i }), {
      target: { value: 'principal' },
    });

    // The only personal key goes, so the Type filter hides; then a new one arrives.
    act(() => {
      client.setQueryData(queryKeys.accessKeys, { keys: fiveKeys });
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('combobox', { name: /filter keys by type/i }),
      ).not.toBeInTheDocument(),
    );
    act(() => {
      client.setQueryData(queryKeys.accessKeys, {
        keys: [...fiveKeys, { ...personal, id: 'key-q', keyName: 'new personal' }],
      });
    });

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /filter keys by type/i })).toHaveValue('all'),
    );
    expect(rowNames()).toHaveLength(6);
  });

  it('leaves out the search below five keys', async () => {
    mockApiRequest.mockResolvedValue({ keys: fiveKeys.slice(0, 4) });
    renderPage();
    await screen.findByText('alpha');

    expect(screen.queryByRole('searchbox', { name: /search keys/i })).not.toBeInTheDocument();
  });
});

describe('ApiKeysPage: the details drawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('links each bucket in the drawer to its page', async () => {
    mockApiRequest.mockResolvedValue({
      keys: [key({ bucketScope: 'specific', buckets: ['any-bucket'] })],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'my key' }));

    expect(screen.getByRole('link', { name: 'any-bucket' })).toBeInTheDocument();
  });
});

describe('ApiKeysPage: a bulk delete that partly fails', () => {
  // The deletion hook refreshes through the app's shared query client, so the
  // page renders with that client here and its refetch reaches the screen.
  afterEach(() => {
    sharedQueryClient.clear();
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A server holding two keys, refusing the deletes `refuse` says to. */
  function mockServer(refuse: (id: string) => Error | undefined) {
    const existing = new Map([
      ['key-1', key()],
      ['key-2', key({ id: 'key-2', keyName: 'other key' })],
    ]);
    mockApiRequest.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method !== 'DELETE') return Promise.resolve({ keys: [...existing.values()] });
      const id = path.split('/').at(-1) ?? '';
      const refusal = refuse(id);
      if (refusal) return Promise.reject(refusal);
      existing.delete(id);
      return Promise.resolve({});
    });
  }

  const withStatus = (message: string, status: number) =>
    Object.assign(new Error(message), { status });

  async function deleteBoth() {
    renderPage(OrgRole.Owner, sharedQueryClient);
    await screen.findByText('my key');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all keys' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 2 keys' }));
  }

  it('says how many were deleted and why the rest were not', async () => {
    mockServer((id) =>
      id === 'key-2' ? withStatus('Not allowed to delete this key', 403) : undefined,
    );
    await deleteBoth();

    expect(
      await screen.findByText("1 deleted. 1 couldn't be deleted: Not allowed to delete this key"),
    ).toBeInTheDocument();
  });

  it('refreshes the key list after the partial failure, so the deleted key stops showing', async () => {
    mockServer((id) =>
      id === 'key-2' ? withStatus('Not allowed to delete this key', 403) : undefined,
    );
    await deleteBoth();

    await waitFor(() => expect(screen.queryByText('my key')).not.toBeInTheDocument());
    expect(screen.getByText('other key')).toBeInTheDocument();
  });

  it('counts a key the server no longer has (404) as deleted', async () => {
    mockServer((id) => (id === 'key-2' ? withStatus('Access key not found', 404) : undefined));
    await deleteBoth();

    expect(await screen.findByText('2 access keys deleted')).toBeInTheDocument();
  });
});
