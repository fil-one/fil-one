import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import { seedPermissions } from '../lib/test-permissions.js';
import { S3Region } from '@filone/shared';
import type { RagApiKey } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { queryKeys } from '../lib/query-client.js';
import { RagApiKeysTab } from './RagPipelineKeysTab.js';
import type { RagBucket } from '../lib/rag-bucket-api.js';

// ---------------------------------------------------------------------------
// Mocks — API client boundary
// ---------------------------------------------------------------------------

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockDelete = vi.fn();

vi.mock('../lib/rag-api-keys-api.js', () => ({
  listRagApiKeys: (...args: unknown[]) => mockList(...args),
  createRagApiKey: (...args: unknown[]) => mockCreate(...args),
  deleteRagApiKey: (...args: unknown[]) => mockDelete(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const TOKEN = 'sk_rag_0123456789abcdefghijklmnopqrstuvwxyzABCDEF';

// `seedPermissions` writes userId 'user-1', so this key is the caller's own —
// which is what a Member's `keys.manage_own` reaches.
const KEY: RagApiKey = {
  id: 'key-1',
  keyName: 'ci key',
  keyPrefix: 'sk_rag_AbC12',
  bucketScope: 'all',
  createdAt: '2026-07-01T00:00:00Z',
  createdBy: 'user-1',
};

/** A key somebody else minted: visible to `keys.manage_all`, not revocable below it. */
const OTHERS_KEY: RagApiKey = {
  ...KEY,
  id: 'key-2',
  keyName: 'someone elses key',
  createdBy: 'user-2',
};

function bucket(over: Partial<RagBucket> = {}): RagBucket {
  return {
    name: 'my-bucket',
    region: S3Region.EuWest1,
    enabled: true,
    filesIndexed: 0,
    indexSize: 0,
    ...over,
  };
}

function renderTab(buckets: RagBucket[] = [bucket()], role: OrgRole = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Key controls are gated on `keys.*`, so the caller's role has to be known
  // before the tab renders.
  seedPermissions(client, role);
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RagApiKeysTab buckets={buckets} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RagApiKeysTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ keys: [] });
  });

  it('renders key rows with prefix, scope, and last-used fallback', async () => {
    mockList.mockResolvedValue({
      keys: [
        KEY,
        {
          ...KEY,
          id: 'key-2',
          keyName: 'scoped key',
          bucketScope: 'specific',
          buckets: [{ region: S3Region.EuWest1, name: 'docs' }],
          lastUsedAt: '2026-07-05T00:00:00Z',
        },
      ],
    });

    renderTab();

    expect(await screen.findByText('ci key')).toBeInTheDocument();
    expect(screen.getAllByText('sk_rag_AbC12…')).toHaveLength(2);
    expect(screen.getByText('All buckets')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('shows an empty state when the org has no keys', async () => {
    renderTab();
    expect(await screen.findByTestId('rag-api-keys-empty')).toBeInTheDocument();
  });

  it('creates a key and reveals the token exactly once', async () => {
    mockCreate.mockResolvedValue({
      id: 'key-9',
      keyName: 'new key',
      keyPrefix: TOKEN.slice(0, 12),
      token: TOKEN,
      bucketScope: 'all',
      createdAt: '2026-07-10T00:00:00Z',
    });

    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Create API key/ }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'new key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({ keyName: 'new key', bucketScope: 'all' }),
    );

    // Shown-once modal: token masked until revealed.
    const tokenField = await screen.findByTestId('rag-key-token');
    expect(tokenField).not.toHaveTextContent(TOKEN);
    fireEvent.click(screen.getByRole('button', { name: 'Show API key' }));
    expect(screen.getByTestId('rag-key-token')).toHaveTextContent(TOKEN);

    // Dismissing the modal removes the token from the DOM for good.
    fireEvent.click(screen.getByRole('button', { name: "I've saved this key" }));
    await waitFor(() => expect(screen.queryByTestId('rag-key-token')).not.toBeInTheDocument());
  });

  it('scopes a key to selected RAG-enabled buckets as (region, name) pairs', async () => {
    mockCreate.mockResolvedValue({
      id: 'key-9',
      keyName: 'scoped',
      keyPrefix: TOKEN.slice(0, 12),
      token: TOKEN,
      bucketScope: 'specific',
      buckets: [{ region: S3Region.EuWest1, name: 'enabled-bucket' }],
      createdAt: '2026-07-10T00:00:00Z',
    });
    renderTab([
      bucket({ name: 'enabled-bucket' }),
      bucket({ name: 'disabled-bucket', enabled: false }),
    ]);

    fireEvent.click(await screen.findByRole('button', { name: /Create API key/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'scoped' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Specific buckets' }));

    // Only RAG-enabled buckets are offered.
    expect(screen.getByLabelText('enabled-bucket')).toBeInTheDocument();
    expect(screen.queryByLabelText('disabled-bucket')).not.toBeInTheDocument();

    // Nothing selected yet — submit stays disabled.
    expect(screen.getByRole('button', { name: 'Create key' })).toBeDisabled();

    fireEvent.click(screen.getByLabelText('enabled-bucket'));
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        keyName: 'scoped',
        bucketScope: 'specific',
        buckets: [{ region: S3Region.EuWest1, name: 'enabled-bucket' }],
      }),
    );
  });

  it('deletes a key after confirmation', async () => {
    mockList.mockResolvedValue({ keys: [KEY] });
    mockDelete.mockResolvedValue(undefined);

    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete API key ci key' }));

    expect(await screen.findByText('Delete "ci key"?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete key' }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('key-1'));
  });

  it('surfaces a create failure as a toast and keeps the modal open', async () => {
    mockCreate.mockRejectedValue(new Error('quota exceeded'));

    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Create API key/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'new key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    expect(await screen.findByText('quota exceeded')).toBeInTheDocument();
    expect(screen.queryByTestId('rag-key-token')).not.toBeInTheDocument();
  });
});

describe('RagApiKeysTab — permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ keys: [] });
  });

  it('offers key creation to a Member', async () => {
    renderTab([bucket()], OrgRole.Member);

    expect(await screen.findByRole('button', { name: 'Create API key' })).toBeInTheDocument();
  });

  it('hides key creation from ReadOnly', async () => {
    renderTab([bucket()], OrgRole.ReadOnly);

    await screen.findByText('No API keys yet');
    expect(screen.queryByRole('button', { name: 'Create API key' })).not.toBeInTheDocument();
  });

  it('does not request the list for a role without keys.manage_own', async () => {
    // ReadOnly's request would 403. The empty state is the honest render, and
    // the invitation to create one goes with the button it has lost.
    renderTab([bucket()], OrgRole.ReadOnly);

    await screen.findByTestId('rag-api-keys-empty');
    expect(mockList).not.toHaveBeenCalled();
    expect(screen.getByText('Keys for the Query API appear here.')).toBeInTheDocument();
  });

  it('lets a Member revoke their own key and not a colleague’s', async () => {
    mockList.mockResolvedValue({ keys: [KEY, OTHERS_KEY] });

    renderTab([bucket()], OrgRole.Member);

    expect(
      await screen.findByRole('button', { name: 'Delete API key ci key' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete API key someone elses key' }),
    ).not.toBeInTheDocument();
  });

  it('drops the key list when the caller loses keys.manage_own mid-session', async () => {
    // Disabling a query does not evict what it already fetched, and a mounted
    // tab is a live observer, so the names and prefixes would stay on screen
    // until a reload.
    mockList.mockResolvedValue({ keys: [KEY] });
    const { client } = renderTab([bucket()], OrgRole.Member);
    expect(await screen.findByText('ci key')).toBeInTheDocument();

    // What a /me refetch after a demotion does.
    act(() => seedPermissions(client, OrgRole.ReadOnly));

    await waitFor(() => expect(screen.queryByText('ci key')).not.toBeInTheDocument());
    // The cached response is still there — the read is what changed.
    expect(client.getQueryData(queryKeys.ragApiKeys)).toBeDefined();
  });

  // Hiding the Create button decides only what can be started. The modal is
  // state the caller chose before the demotion, and its Create key button
  // would still issue the request the hidden button exists to avoid.
  it('closes an open create modal when the caller loses keys.create', async () => {
    const { client } = renderTab([bucket()], OrgRole.Member);
    fireEvent.click(await screen.findByRole('button', { name: /Create API key/ }));
    expect(await screen.findByLabelText('Name')).toBeInTheDocument();

    // What a /me refetch after a demotion does.
    act(() => seedPermissions(client, OrgRole.ReadOnly));

    await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());
  });

  // The delete confirmation carries its target, so the gate is the same per-key
  // revoke rule as the row's own button: a demotion from `keys.manage_all` to
  // `keys.manage_own` takes a colleague's key out of reach mid-confirmation.
  it('closes a delete confirmation for a key the narrowed role may no longer revoke', async () => {
    mockList.mockResolvedValue({ keys: [KEY, OTHERS_KEY] });
    const { client } = renderTab([bucket()], OrgRole.Admin);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete API key someone elses key' }),
    );
    expect(await screen.findByText('Delete "someone elses key"?')).toBeInTheDocument();

    // What a /me refetch after a demotion does.
    act(() => seedPermissions(client, OrgRole.Member));

    await waitFor(() =>
      expect(screen.queryByText('Delete "someone elses key"?')).not.toBeInTheDocument(),
    );
  });

  it('gives an Admin the action on every key', async () => {
    mockList.mockResolvedValue({ keys: [KEY, OTHERS_KEY] });

    renderTab([bucket()], OrgRole.Admin);

    expect(
      await screen.findByRole('button', { name: 'Delete API key ci key' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Delete API key someone elses key' }),
    ).toBeInTheDocument();
  });
});
