import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { S3Region, type Bucket, type ListBucketsResponse } from '@filone/shared';

import { queryKeys } from '../lib/query-client.js';
import { AccessKeyBucketScopeFields } from './AccessKeyBucketScopeFields.js';

const defaultBuckets: Bucket[] = [
  { name: 'midwest-a', region: 'us-midwest-1', createdAt: '2026-01-01T00:00:00Z', isPublic: false },
  { name: 'midwest-b', region: 'us-midwest-1', createdAt: '2026-01-02T00:00:00Z', isPublic: false },
  { name: 'eu-a', region: 'eu-west-1', createdAt: '2026-01-03T00:00:00Z', isPublic: false },
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
  it('shows only us-midwest-1 buckets when region is us-midwest-1', () => {
    renderWith({ region: S3Region.UsMidwest1 });
    expect(screen.getByRole('checkbox', { name: 'midwest-a' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'midwest-b' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'eu-a' })).not.toBeInTheDocument();
  });

  it('shows only eu-west-1 buckets when region is eu-west-1', () => {
    renderWith({ region: S3Region.EuWest1 });
    expect(screen.getByRole('checkbox', { name: 'eu-a' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'midwest-a' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'midwest-b' })).not.toBeInTheDocument();
  });

  it('keeps a selected bucket from a different region visible and checked', () => {
    renderWith({ region: S3Region.EuWest1, selectedBuckets: ['midwest-a'] });
    const midwestA = screen.getByRole('checkbox', { name: 'midwest-a' });
    expect(midwestA).toBeInTheDocument();
    expect(midwestA).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'eu-a' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'midwest-b' })).not.toBeInTheDocument();
  });

  it('keeps a pinnedBucket from a different region visible (unchecked)', () => {
    renderWith({ region: S3Region.UsMidwest1, pinnedBucket: 'eu-a' });
    const euA = screen.getByRole('checkbox', { name: 'eu-a' });
    expect(euA).toBeInTheDocument();
    expect(euA).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'midwest-a' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'midwest-b' })).toBeInTheDocument();
  });

  it('renders the empty state when the filtered list is empty and nothing is selected or pinned', () => {
    renderWith({
      region: S3Region.UsMidwest1,
      buckets: [
        { name: 'eu-a', region: 'eu-west-1', createdAt: '2026-01-03T00:00:00Z', isPublic: false },
      ],
    });
    expect(screen.getByText('No buckets found.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
