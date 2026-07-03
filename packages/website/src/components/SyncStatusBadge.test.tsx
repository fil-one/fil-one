import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { S3Region } from '@filone/shared';

import { SyncStatusBadge } from './SyncStatusBadge';
import { type RagBucket } from '../lib/rag-bucket-api.js';

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

describe('SyncStatusBadge', () => {
  it('renders a "Syncing…" badge while a reconciliation is in flight', () => {
    render(<SyncStatusBadge bucket={bucket({ syncState: 'syncing' })} />);
    expect(screen.getByText('Syncing…')).toBeInTheDocument();
  });

  it('exposes a stable, label-independent hook for the syncing state', () => {
    render(<SyncStatusBadge bucket={bucket({ syncState: 'syncing' })} />);
    const badge = screen.getByTestId('sync-status-badge');
    expect(badge).toHaveAttribute('data-sync-state', 'syncing');
  });

  it('exposes a stable, label-independent hook for the error state', () => {
    render(<SyncStatusBadge bucket={bucket({ syncState: 'error' })} />);
    const badge = screen.getByTestId('sync-status-badge');
    expect(badge).toHaveAttribute('data-sync-state', 'error');
  });

  it('renders "Sync failed" with the error message in the tooltip on error', () => {
    render(
      <SyncStatusBadge
        bucket={bucket({ syncState: 'error', lastSyncError: 'Connection timeout' })}
      />,
    );
    expect(screen.getByText('Sync failed')).toHaveAttribute('title', 'Connection timeout');
  });

  it('falls back to a plain "Sync failed" title when no error message is present', () => {
    render(<SyncStatusBadge bucket={bucket({ syncState: 'error' })} />);
    expect(screen.getByText('Sync failed')).toHaveAttribute('title', 'Sync failed');
  });

  it('renders nothing for the idle/steady state', () => {
    const { container } = render(<SyncStatusBadge bucket={bucket({ syncState: 'idle' })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when syncState is absent', () => {
    const { container } = render(<SyncStatusBadge bucket={bucket()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
