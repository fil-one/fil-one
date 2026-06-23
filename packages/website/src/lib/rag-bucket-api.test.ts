import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('getBucketRagEnabled GETs the per-bucket enablement endpoint', async () => {
    await getBucketRagEnabled('my-bucket');
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/my-bucket/rag/enabled');
  });

  it('encodes the bucket name in the enablement read path', async () => {
    await getBucketRagEnabled('weird/name');
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/weird%2Fname/rag/enabled');
  });

  it('setBucketRagEnabled POSTs the enabled flag', async () => {
    await setBucketRagEnabled('my-bucket', true);
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/my-bucket/rag/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    });
  });

  it('setBucketRagEnabled can disable', async () => {
    await setBucketRagEnabled('my-bucket', false);
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/my-bucket/rag/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: false }),
    });
  });

  it('queryBucket POSTs the query with optional top_k/model omitted by default', async () => {
    await queryBucket('my-bucket', 'hello');
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/my-bucket/query', {
      method: 'POST',
      body: JSON.stringify({ query: 'hello' }),
    });
  });

  it('queryBucket includes top_k and model when provided', async () => {
    await queryBucket('my-bucket', 'hello', { topK: 5, model: 'm' });
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/my-bucket/query', {
      method: 'POST',
      body: JSON.stringify({ query: 'hello', top_k: 5, model: 'm' }),
    });
  });
});
