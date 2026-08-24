import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { S3Region, type Bucket, type ListBucketsResponse } from '@filone/shared';

import { queryKeys } from '../lib/query-client.js';
import { AccessKeyBucketScopeFields } from './AccessKeyBucketScopeFields.js';

const defaultBuckets: Bucket[] = [
  { bucketName: 'us-a', region: 'us-east-1', createdAt: '2026-01-01T00:00:00Z', isPublic: false },
  { bucketName: 'us-b', region: 'us-east-1', createdAt: '2026-01-02T00:00:00Z', isPublic: false },
  { bucketName: 'eu-a', region: 'eu-west-1', createdAt: '2026-01-03T00:00:00Z', isPublic: false },
];

function renderWith(props: {
  region: S3Region;
  selectedBuckets?: string[];
  pinnedBucket?: string;
  buckets?: Bucket[];
  unavailableRegions?: S3Region[];
}) {
  const data: ListBucketsResponse = {
    buckets: props.buckets ?? defaultBuckets,
    ...(props.unavailableRegions && { unavailableRegions: props.unavailableRegions }),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.buckets, data);
  return render(
    <QueryClientProvider client={client}>
      <AccessKeyBucketScopeFields
        bucketScope="specific"
        onBucketScopeChange={vi.fn()}
        selectedBuckets={props.selectedBuckets ?? []}
        onSelectedBucketsChange={vi.fn()}
        pinnedBucket={props.pinnedBucket}
        region={props.region}
      />
    </QueryClientProvider>,
  );
}

describe('AccessKeyBucketScopeFields region filtering', () => {
  it('shows only us-east-1 buckets when region is us-east-1', () => {
    renderWith({ region: S3Region.UsEast1 });
    expect(screen.getByRole('checkbox', { name: 'us-a' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'us-b' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'eu-a' })).not.toBeInTheDocument();
  });

  it('shows only eu-west-1 buckets when region is eu-west-1', () => {
    renderWith({ region: S3Region.EuWest1 });
    expect(screen.getByRole('checkbox', { name: 'eu-a' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'us-a' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'us-b' })).not.toBeInTheDocument();
  });

  it('keeps a selected bucket from a different region visible and checked', () => {
    renderWith({ region: S3Region.EuWest1, selectedBuckets: ['us-a'] });
    const usA = screen.getByRole('checkbox', { name: 'us-a' });
    expect(usA).toBeInTheDocument();
    expect(usA).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'eu-a' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'us-b' })).not.toBeInTheDocument();
  });

  it('keeps a pinnedBucket from a different region visible (unchecked)', () => {
    renderWith({ region: S3Region.UsEast1, pinnedBucket: 'eu-a' });
    const euA = screen.getByRole('checkbox', { name: 'eu-a' });
    expect(euA).toBeInTheDocument();
    expect(euA).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'us-a' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'us-b' })).toBeInTheDocument();
  });

  it('renders the empty state when the filtered list is empty and nothing is selected or pinned', () => {
    renderWith({
      region: S3Region.UsEast1,
      buckets: [
        {
          bucketName: 'eu-a',
          region: 'eu-west-1',
          createdAt: '2026-01-03T00:00:00Z',
          isPublic: false,
        },
      ],
    });
    expect(screen.getByText('No buckets found.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('AccessKeyBucketScopeFields degraded regions', () => {
  const DEGRADED = 'Cannot list buckets in the us-east-1 region. Please try again later.';

  it('warns when the selected region could not be listed', () => {
    renderWith({ region: S3Region.UsEast1, unavailableRegions: [S3Region.UsEast1] });
    expect(screen.getByText(DEGRADED)).toBeInTheDocument();
  });

  it('still lists the buckets the region did return', () => {
    renderWith({ region: S3Region.UsEast1, unavailableRegions: [S3Region.UsEast1] });
    expect(screen.getByRole('checkbox', { name: 'us-a' })).toBeInTheDocument();
  });

  it('replaces "No buckets found." with the warning when nothing came back', () => {
    renderWith({
      region: S3Region.UsEast1,
      buckets: [],
      unavailableRegions: [S3Region.UsEast1],
    });
    expect(screen.getByText(DEGRADED)).toBeInTheDocument();
    expect(screen.queryByText('No buckets found.')).not.toBeInTheDocument();
  });

  it('stays quiet when a region other than the selected one is degraded', () => {
    renderWith({ region: S3Region.UsEast1, unavailableRegions: [S3Region.EuWest1] });
    expect(screen.queryByText(/Cannot list buckets/)).not.toBeInTheDocument();
  });

  // A degraded region must not silently unscope a key that is mid-edit.
  it('keeps an already-selected bucket checked while its region is degraded', () => {
    renderWith({
      region: S3Region.UsEast1,
      buckets: [],
      selectedBuckets: ['us-a'],
      unavailableRegions: [S3Region.UsEast1],
    });
    expect(screen.getByRole('checkbox', { name: 'us-a' })).toBeChecked();
  });
});
