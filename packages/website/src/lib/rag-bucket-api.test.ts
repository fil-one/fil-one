import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Region } from '@filone/shared';

const mockApiRequest = vi.fn();
vi.mock('./api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

import {
  getBucketRagEnabled,
  listBucketsForRag,
  queryBucket,
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
