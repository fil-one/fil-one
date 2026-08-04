import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Region } from '@filone/shared';

const mockApiRequest = vi.fn();
vi.mock('./api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

import {
  bucketDisplayState,
  getBucketRagEnabled,
  isBucketQueryable,
  listBucketsForRag,
  queryBucket,
  type RagBucket,
  setBucketRagEnabled,
} from './rag-bucket-api.js';

describe('rag-bucket-api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiRequest.mockResolvedValue({});
  });

  it('listBucketsForRag GETs /buckets', async () => {
    await listBucketsForRag();
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets');
  });

  it('getBucketRagEnabled GETs the per-bucket enablement endpoint with the region', async () => {
    await getBucketRagEnabled('my-bucket', S3Region.UsEast1);
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/my-bucket/rag/enabled?region=us-east-1');
  });

  it('encodes the bucket name in the enablement read path', async () => {
    await getBucketRagEnabled('weird/name', S3Region.UsEast1);
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/buckets/weird%2Fname/rag/enabled?region=us-east-1',
    );
  });

  it('threads a non-us-east-1 region through the enablement read path', async () => {
    await getBucketRagEnabled('my-bucket', S3Region.EuWest1);
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/my-bucket/rag/enabled?region=eu-west-1');
  });

  it('setBucketRagEnabled POSTs the enabled flag with the region', async () => {
    await setBucketRagEnabled('my-bucket', S3Region.UsEast1, true);
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/my-bucket/rag/enabled?region=us-east-1', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    });
  });

  it('setBucketRagEnabled can disable and threads the region', async () => {
    await setBucketRagEnabled('my-bucket', S3Region.EuWest1, false);
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/my-bucket/rag/enabled?region=eu-west-1', {
      method: 'POST',
      body: JSON.stringify({ enabled: false }),
    });
  });

  it('queryBucket POSTs the query with the region and optional top_k/model omitted by default', async () => {
    await queryBucket('my-bucket', S3Region.UsEast1, 'hello');
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/my-bucket/query?region=us-east-1', {
      method: 'POST',
      body: JSON.stringify({ query: 'hello' }),
    });
  });

  it('queryBucket includes top_k and model when provided and threads the region', async () => {
    await queryBucket('my-bucket', S3Region.EuWest1, 'hello', { topK: 5, model: 'm' });
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/my-bucket/query?region=eu-west-1', {
      method: 'POST',
      body: JSON.stringify({ query: 'hello', top_k: 5, model: 'm' }),
    });
  });
});

// ---------------------------------------------------------------------------
// Display-state helpers
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

describe('isBucketQueryable', () => {
  it('is false for a bucket that is not enabled', () => {
    expect(
      isBucketQueryable(bucket({ enabled: false, lastSyncedAt: '2026-01-01T00:00:00Z' })),
    ).toBe(false);
  });

  it('is false while an enabled bucket still awaits its first completed pass', () => {
    expect(isBucketQueryable(bucket())).toBe(false);
  });

  it('is true once a pass has completed', () => {
    expect(isBucketQueryable(bucket({ lastSyncedAt: '2026-01-01T00:00:00Z' }))).toBe(true);
  });

  it('stays true while a re-index is in flight, since the previous index still answers', () => {
    expect(
      isBucketQueryable(bucket({ syncState: 'syncing', lastSyncedAt: '2026-01-01T00:00:00Z' })),
    ).toBe(true);
  });

  it('agrees with bucketDisplayState on an empty-string timestamp', () => {
    // These two helpers exist to keep the row, the status, and the drawer
    // aligned, so neither may treat a falsy timestamp as a completed pass.
    const b = bucket({ lastSyncedAt: '' });
    expect(bucketDisplayState(b)).toBe('awaiting-first-index');
    expect(isBucketQueryable(b)).toBe(false);
  });
});
