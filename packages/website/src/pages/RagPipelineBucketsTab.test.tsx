import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, S3Region } from '@filone/shared';

import { BucketsTab, type RagBucket } from './RagPipelineBucketsTab.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';

// ---------------------------------------------------------------------------
// Mocks — the query playground client. Only the permission tests below open a
// drawer, and none of them asks a question, so the call is never made; it is
// mocked to keep the module graph free of the network boundary.
// ---------------------------------------------------------------------------

vi.mock('../lib/rag-bucket-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/rag-bucket-api.js')>()),
  queryBucket: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bucket(over: Partial<RagBucket> = {}): RagBucket {
  return {
    name: 'my-bucket',
    region: S3Region.UsEast1,
    enabled: true,
    filesIndexed: 0,
    indexSize: 0,
    ...over,
  };
}

function renderTab(buckets: RagBucket[], role: OrgRole = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Index / Stop-indexing are gated on the bucket permissions, so the caller's
  // role has to be in the cache before the rows render.
  seedPermissions(client, role);
  // The client comes back so a test can re-seed it mid-render, which is what a
  // role change under an open confirmation looks like.
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        {/* The drawer's code snippet copies to the clipboard through a toast. */}
        <ToastProvider>
          <BucketsTab
            buckets={buckets}
            isLoading={false}
            isError={false}
            errorMessage={undefined}
            togglingBucket={null}
            onConfirmToggle={() => undefined}
          />
        </ToastProvider>
      </QueryClientProvider>,
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests — sync telemetry display (FIL-556)
// ---------------------------------------------------------------------------

describe('BucketsTab — sync telemetry display', () => {
  it('renders files indexed, index size (via formatBytes) and last-synced for a synced bucket', () => {
    const { container } = renderTab([
      bucket({
        syncState: 'idle',
        filesIndexed: 42,
        indexSize: 1_048_576,
        lastSyncedAt: '2026-06-22T11:59:00Z',
      }),
    ]);

    // The count + formatted size render in their own spans.
    expect(screen.getByText('42')).toBeInTheDocument();
    // formatBytes uses base-1000: 1_048_576 → "1 MB".
    expect(screen.getByText('1 MB')).toBeInTheDocument();
    // The full description line (text split across nodes) reads as a sentence.
    expect(container.textContent).toContain('42 files indexed');
    expect(container.textContent).toContain('Last synced');
    // No sync-failed / syncing noise in the steady state.
    expect(screen.queryByText('Syncing…')).not.toBeInTheDocument();
    expect(screen.queryByText(/Sync failed/)).not.toBeInTheDocument();
  });

  it('states the wait for an enabled bucket that has never completed a pass', () => {
    // No syncState at all (absent): the never-indexed/idle case.
    const { container } = renderTab([bucket({ filesIndexed: 0, indexSize: 0 })]);

    expect(container.textContent).toContain('Up to 6 hours until the first results');
  });

  it('renders an "Indexing…" indicator while a reconciliation is in flight, still treating the bucket as enabled', () => {
    renderTab([bucket({ enabled: true, syncState: 'syncing' })]);

    expect(screen.getByTestId('bucket-status')).toHaveTextContent('Indexing');
    expect(screen.getByText('Checking for new and changed files')).toBeInTheDocument();
    // While syncing we suppress the (stale/partial) file-count line.
    expect(screen.queryByText('files indexed')).not.toBeInTheDocument();
    // Sync state must NOT change enablement: the row keeps the drawer action and
    // never falls back to the "Index" (enable) button.
    expect(screen.getByTestId('bucket-row-ask')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Index' })).not.toBeInTheDocument();
  });

  it('renders "Indexing failed" with the error message after a failed sync, still treating the bucket as enabled', () => {
    renderTab([bucket({ enabled: true, syncState: 'error', lastSyncError: 'Connection timeout' })]);

    expect(screen.getByTestId('bucket-status')).toHaveTextContent('Failed');
    expect(screen.getByText('Connection timeout')).toBeInTheDocument();
    // A failed sync must NOT disable the bucket.
    expect(screen.getByTestId('bucket-row-ask')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Index' })).not.toBeInTheDocument();
  });

  it('renders a plain "Indexing failed" when no error message is present', () => {
    renderTab([bucket({ enabled: true, syncState: 'error' })]);

    expect(screen.getByTestId('bucket-status')).toHaveTextContent('Failed');
    expect(screen.getByText('The last indexing run did not complete')).toBeInTheDocument();
  });

  it('renders "Not indexed" for a disabled bucket without telemetry noise', () => {
    // A disabled bucket is not enabled regardless of any stale sync state.
    renderTab([bucket({ enabled: false })]);

    expect(screen.getByText('Not indexed')).toBeInTheDocument();
    expect(screen.queryByText('files indexed')).not.toBeInTheDocument();
    expect(screen.queryByText('Syncing…')).not.toBeInTheDocument();
    expect(screen.queryByText(/Sync failed/)).not.toBeInTheDocument();
  });

  it('exposes stable, label-independent E2E hooks: the row by name and the sync state', () => {
    renderTab([
      bucket({ name: 'alpha', enabled: true, syncState: 'syncing' }),
      bucket({ name: 'beta', enabled: true, syncState: 'error' }),
      bucket({
        name: 'gamma',
        enabled: true,
        syncState: 'idle',
        lastSyncedAt: '2026-06-22T11:59:00Z',
      }),
      bucket({ name: 'epsilon', enabled: true, syncState: 'idle' }),
      bucket({ name: 'delta', enabled: false }),
    ]);

    // Rows are identifiable by bucket name, not by their text label.
    const alpha = document.querySelector('[data-bucket-name="alpha"]');
    expect(alpha).not.toBeNull();

    const statusOf = (name: string) =>
      document
        .querySelector(`[data-bucket-name="${name}"]`)
        ?.querySelector('[data-testid="bucket-row-status"]')
        ?.getAttribute('data-sync-state');

    expect(statusOf('alpha')).toBe('syncing');
    expect(statusOf('beta')).toBe('error');
    expect(statusOf('gamma')).toBe('synced');
    expect(statusOf('delta')).toBe('not-indexed');
    // Enabled but no completed pass: must not read as ready.
    expect(statusOf('epsilon')).toBe('awaiting-first-index');
  });
});

// ---------------------------------------------------------------------------
// First-indexing-pass gate — Ask questions availability
// ---------------------------------------------------------------------------

describe('BucketsTab — before the first indexing pass', () => {
  it('offers details rather than asking, and states the wait instead of empty stats', () => {
    renderTab([bucket({ enabled: true, syncState: 'idle' })]);

    // The drawer must stay reachable (it holds the API snippet), but the label
    // must not offer asking while the question input inside is disabled.
    const action = screen.getByTestId('bucket-row-ask');
    expect(action).toBeEnabled();
    expect(action).toHaveTextContent('View details');
    expect(screen.queryByRole('button', { name: 'Ask questions' })).not.toBeInTheDocument();

    // The wait is the only fact worth showing; 0 files / 0 B are not.
    expect(screen.getByTestId('bucket-row-status')).toHaveTextContent(
      /Up to 6 hours until the first results/,
    );
    expect(screen.queryByTestId('bucket-row-stat-files')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bucket-row-stat-size')).not.toBeInTheDocument();
  });

  it('does not report a bucket as ready before it can answer', () => {
    renderTab([bucket({ enabled: true, syncState: 'idle' })]);

    const badge = screen.getByTestId('bucket-status');
    expect(badge).toHaveTextContent('Indexing');
    expect(badge).not.toHaveTextContent('Ready');
  });

  it('offers asking, with stats and a ready status, once a pass has completed', () => {
    renderTab([bucket({ enabled: true, filesIndexed: 847, lastSyncedAt: '2026-06-22T11:59:00Z' })]);

    const action = screen.getByTestId('bucket-row-ask');
    expect(action).toBeEnabled();
    expect(action).toHaveTextContent('Ask questions');
    expect(screen.getByTestId('bucket-row-stat-files')).toHaveTextContent('847');
    expect(screen.getByTestId('bucket-status')).toHaveTextContent('Ready');
  });
});

describe('BucketsTab — permissions', () => {
  it('offers Index to a Member, who may create buckets', () => {
    renderTab([bucket({ enabled: false })], OrgRole.Member);

    expect(screen.getByRole('button', { name: 'Index' })).toBeInTheDocument();
  });

  it('hides Index from ReadOnly', () => {
    renderTab([bucket({ enabled: false })], OrgRole.ReadOnly);

    expect(screen.queryByRole('button', { name: 'Index' })).not.toBeInTheDocument();
  });

  it.each([OrgRole.Member, OrgRole.ReadOnly])(
    'hides the stop-indexing menu from %s — that discards the index',
    (role) => {
      renderTab([bucket({ enabled: true })], role);

      expect(screen.queryByRole('button', { name: 'Bucket actions' })).not.toBeInTheDocument();
      // Reading the bucket is still theirs.
      expect(screen.getByTestId('bucket-row-ask')).toBeInTheDocument();
    },
  );

  it('shows the stop-indexing menu to an Admin', () => {
    renderTab([bucket({ enabled: true })], OrgRole.Admin);

    expect(screen.getByRole('button', { name: 'Bucket actions' })).toBeInTheDocument();
  });

  it.each([OrgRole.Member, OrgRole.ReadOnly])(
    'hides stop indexing inside the drawer from %s as well as in the row',
    async (role) => {
      // The drawer stays open to them — it holds the API snippet — so hiding the
      // row's kebab alone still left a button that comes back 403.
      renderTab([bucket({ enabled: true })], role);
      fireEvent.click(screen.getByTestId('bucket-row-ask'));

      expect(await screen.findByTestId('bucket-drawer')).toBeInTheDocument();
      expect(screen.queryByTestId('bucket-drawer-stop')).not.toBeInTheDocument();
    },
  );

  // Hiding the kebab decides only what can be started. The confirmation is
  // state the caller chose before the demotion, and its Stop indexing button
  // would still discard the index the hidden control exists to protect.
  it('closes an open stop-indexing confirmation when the caller loses buckets.delete', async () => {
    const { client } = renderTab([bucket({ enabled: true })], OrgRole.Admin);
    fireEvent.click(screen.getByTestId('bucket-action-menu-trigger'));
    fireEvent.click(await screen.findByTestId('bucket-action-menu-disable'));
    expect(await screen.findByTestId('toggle-confirm-submit')).toBeInTheDocument();

    // What a /me refetch after a demotion does.
    act(() => seedPermissions(client, OrgRole.Member));

    await waitFor(() =>
      expect(screen.queryByTestId('toggle-confirm-submit')).not.toBeInTheDocument(),
    );
  });

  it('offers stop indexing inside the drawer to an Admin', async () => {
    renderTab([bucket({ enabled: true })], OrgRole.Admin);
    fireEvent.click(screen.getByTestId('bucket-row-ask'));

    expect(await screen.findByTestId('bucket-drawer-stop')).toBeInTheDocument();
  });
});
