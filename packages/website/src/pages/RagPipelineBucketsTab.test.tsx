import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { S3Region } from '@filone/shared';

import { BucketsTab, type RagBucket } from './RagPipelineBucketsTab.js';

// ---------------------------------------------------------------------------
// Mocks — the query playground client (only touched once a drawer opens, which
// these row-level display tests never do). Mocked so the module graph stays
// free of the network/router boundary.
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

function renderTab(buckets: RagBucket[]) {
  return render(
    <BucketsTab
      buckets={buckets}
      isLoading={false}
      isError={false}
      errorMessage={undefined}
      togglingBucket={null}
      onConfirmToggle={() => undefined}
    />,
  );
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

  it('renders "Not yet synced" for an enabled bucket that has never synced', () => {
    // No syncState at all (absent) — the never-synced/idle case.
    const { container } = renderTab([bucket({ filesIndexed: 0, indexSize: 0 })]);

    expect(container.textContent).toContain('Not yet synced');
  });

  it('renders a "Syncing…" indicator while a reconciliation is in flight, still treating the bucket as enabled', () => {
    renderTab([bucket({ enabled: true, syncState: 'syncing' })]);

    expect(screen.getByText('Syncing…')).toBeInTheDocument();
    // While syncing we suppress the (stale/partial) file-count line.
    expect(screen.queryByText('files indexed')).not.toBeInTheDocument();
    // Sync state must NOT change enablement: the bucket stays queryable.
    expect(screen.getByRole('button', { name: 'Ask questions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Index' })).not.toBeInTheDocument();
  });

  it('renders "Sync failed" with the error message after a failed sync, still treating the bucket as enabled', () => {
    renderTab([bucket({ enabled: true, syncState: 'error', lastSyncError: 'Connection timeout' })]);

    expect(screen.getByText(/Sync failed: Connection timeout/)).toBeInTheDocument();
    // A failed sync must NOT disable/un-query the bucket.
    expect(screen.getByRole('button', { name: 'Ask questions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Index' })).not.toBeInTheDocument();
  });

  it('renders a plain "Sync failed" when no error message is present', () => {
    renderTab([bucket({ enabled: true, syncState: 'error' })]);

    expect(screen.getByText('Sync failed')).toBeInTheDocument();
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
      bucket({ name: 'gamma', enabled: true, syncState: 'idle' }),
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
  });
});

// ---------------------------------------------------------------------------
// First-indexing-pass gate — Ask questions availability
// ---------------------------------------------------------------------------

describe('BucketsTab — Ask questions before the first indexing pass', () => {
  it('disables the button with an explanatory tooltip until the first sync completes', () => {
    renderTab([bucket({ enabled: true, syncState: 'syncing' })]);

    const ask = screen.getByRole('button', { name: 'Ask questions' });
    expect(ask).toBeDisabled();

    // The tooltip trigger is the wrapper around the (disabled) button.
    fireEvent.mouseEnter(ask.parentElement!);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/after the first indexing pass/);
  });

  it('enables the button once the bucket has a completed sync', () => {
    renderTab([bucket({ enabled: true, lastSyncedAt: '2026-06-22T11:59:00Z' })]);

    const ask = screen.getByRole('button', { name: 'Ask questions' });
    expect(ask).toBeEnabled();
    fireEvent.mouseEnter(ask.parentElement!);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
