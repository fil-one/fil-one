import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { S3Region } from '@filone/shared';

import { BucketStatus } from './BucketStatus';
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

const SYNCED_AT = '2026-01-01T00:00:00Z';

describe('BucketStatus', () => {
  it('reads "Not indexed" when indexing has never been turned on', () => {
    render(<BucketStatus bucket={bucket({ enabled: false })} />);
    expect(screen.getByText('Not indexed')).toBeInTheDocument();
    expect(screen.getByTestId('bucket-status')).toHaveAttribute('data-sync-state', 'not-indexed');
  });

  it('reads "Indexing" while an enabled bucket waits on its first pass', () => {
    render(<BucketStatus bucket={bucket()} />);
    expect(screen.getByText('Indexing')).toBeInTheDocument();
    expect(screen.getByTestId('bucket-status')).toHaveAttribute(
      'data-sync-state',
      'awaiting-first-index',
    );
  });

  it('reads "Indexing" while a reconciliation is in flight', () => {
    render(<BucketStatus bucket={bucket({ syncState: 'syncing', lastSyncedAt: SYNCED_AT })} />);
    expect(screen.getByText('Indexing')).toBeInTheDocument();
    expect(screen.getByTestId('bucket-status')).toHaveAttribute('data-sync-state', 'syncing');
  });

  it('reads "Failed" when the last pass errored', () => {
    render(<BucketStatus bucket={bucket({ syncState: 'error', lastSyncedAt: SYNCED_AT })} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByTestId('bucket-status')).toHaveAttribute('data-sync-state', 'error');
  });

  it('reads "Ready" only once a pass has completed', () => {
    render(<BucketStatus bucket={bucket({ syncState: 'idle', lastSyncedAt: SYNCED_AT })} />);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByTestId('bucket-status')).toHaveAttribute('data-sync-state', 'synced');
  });

  it('colours only the dot, leaving the label neutral so a list of statuses stays quiet', () => {
    render(<BucketStatus bucket={bucket({ syncState: 'error', lastSyncedAt: SYNCED_AT })} />);
    const status = screen.getByTestId('bucket-status');
    const dot = status.querySelector('[aria-hidden="true"]');
    expect(dot).toHaveClass('bg-red-500');
    expect(screen.getByText('Failed')).toHaveClass('text-zinc-600');
  });

  it('reserves green for buckets that can actually answer a question', () => {
    const { rerender } = render(<BucketStatus bucket={bucket()} />);
    const dot = () => screen.getByTestId('bucket-status').querySelector('[aria-hidden="true"]');
    // Enabled but never indexed: in progress, not ready.
    expect(dot()).toHaveClass('bg-amber-500');

    rerender(<BucketStatus bucket={bucket({ syncState: 'idle', lastSyncedAt: SYNCED_AT })} />);
    expect(dot()).toHaveClass('bg-green-500');
  });

  it('pulses the dot only while indexing is actually in progress', () => {
    const { rerender } = render(<BucketStatus bucket={bucket()} />);
    const dot = () => screen.getByTestId('bucket-status').querySelector('[aria-hidden="true"]');
    expect(dot()).toHaveClass('animate-pulse');

    rerender(<BucketStatus bucket={bucket({ syncState: 'error', lastSyncedAt: SYNCED_AT })} />);
    expect(dot()).not.toHaveClass('animate-pulse');
  });

  it('hides the decorative dot from assistive tech, leaving the label to carry the state', () => {
    render(<BucketStatus bucket={bucket({ syncState: 'idle', lastSyncedAt: SYNCED_AT })} />);
    expect(
      screen.getByTestId('bucket-status').querySelector('[aria-hidden="true"]'),
    ).not.toBeNull();
  });
});
