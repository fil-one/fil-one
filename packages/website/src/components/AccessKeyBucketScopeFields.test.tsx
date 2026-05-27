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
}) {
  const data: ListBucketsResponse = { buckets: props.buckets ?? defaultBuckets };
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
