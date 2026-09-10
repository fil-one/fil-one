import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, S3Region } from '@filone/shared';
import type { AccessKey } from '@filone/shared';

const mockApiRequest = vi.fn();
const mockGetUsage = vi.fn(() => Promise.resolve({ tenantStatus: 'active' }));

vi.mock('../lib/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getMe: vi.fn(() => new Promise(() => {})),
  // `useAccountDisabled` reads /usage. Tests that care about the disabled state
  // seed the query cache instead; this keeps the rest from calling undefined.
  getUsage: () => mockGetUsage(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

import { ApiKeysPage } from './ApiKeysPage.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { queryKeys } from '../lib/query-client.js';
import { seedPermissions } from '../lib/test-permissions.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function key(over: Partial<AccessKey> = {}): AccessKey {
  return {
    id: 'key-1',
    keyName: 'my key',
    accessKeyId: 'ACCESS_KEY_12345EXAMPL',
    createdAt: '2026-01-15T10:00:00Z',
    status: 'active',
    permissions: ['read', 'list'],
    bucketScope: 'all',
    region: S3Region.UsEast1,
    createdBy: 'user-1',
    ...over,
  };
}

function renderPage(role: OrgRole = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
      keys: [key(), key({ id: 'key-2', keyName: 'theirs', createdBy: 'user-2' })],
    });

    renderPage(OrgRole.Member);

    expect(await screen.findByText('my key')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Key actions' })).toHaveLength(1);
  });

  it('requests the list for a Member — the server narrows it', async () => {
    mockApiRequest.mockResolvedValue({ keys: [key()] });

    renderPage(OrgRole.Member);

    expect(await screen.findByText('my key')).toBeInTheDocument();
    expect(mockApiRequest).toHaveBeenCalledWith('/access-keys');
  });
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
