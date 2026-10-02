import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiErrorCode, S3Region } from '@filone/shared';
import type { BucketPolicy } from '@filone/shared';

const mockApiRequest = vi.fn();
vi.mock('./api.js', async () => ({
  ...(await vi.importActual<typeof import('./api.js')>('./api.js')),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

import {
  deleteBucketPolicy,
  getBucketPolicy,
  isPolicyConflict,
  putBucketPolicy,
} from './bucket-policy-api.js';

const policy: BucketPolicy = {
  statement: [{ effect: 'allow', principal: ['user-1'], action: ['s3:GetObject'] }],
};
const failure = (status: number, code?: string) =>
  Object.assign(new Error('refused'), { status, ...(code ? { code } : {}) });

describe('bucket policy client', () => {
  beforeEach(() => {
    mockApiRequest.mockReset();
  });

  it('reads the policy with its etag from the bucket route', async () => {
    mockApiRequest.mockResolvedValue({ policy, etag: '"v1"' });

    await expect(getBucketPolicy('photos', S3Region.UsEast9)).resolves.toStrictEqual({
      policy,
      etag: '"v1"',
    });
    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/photos/policy?region=us-east-9');
  });

  it('reads a bucket with no policy as null, and lets every other failure through', async () => {
    mockApiRequest.mockRejectedValueOnce(failure(404, ApiErrorCode.POLICY_NOT_FOUND));
    await expect(getBucketPolicy('photos', S3Region.UsEast9)).resolves.toBeNull();

    mockApiRequest.mockRejectedValueOnce(failure(404));
    await expect(getBucketPolicy('photos', S3Region.UsEast9)).rejects.toThrow('refused');
  });

  it('writes the document with the etag it read, and creates without one', async () => {
    mockApiRequest.mockResolvedValue({ etag: '"v2"', created: false });

    await putBucketPolicy('photos', S3Region.UsEast9, { policy, etag: '"v1"' });

    expect(mockApiRequest).toHaveBeenCalledWith('/buckets/photos/policy?region=us-east-9', {
      method: 'PUT',
      body: JSON.stringify({ policy, etag: '"v1"' }),
    });
  });

  it('removes the policy by the etag it read, in the query', async () => {
    mockApiRequest.mockResolvedValue(undefined);

    await deleteBucketPolicy('photos', S3Region.UsEast9, '"v1"');

    expect(mockApiRequest).toHaveBeenCalledWith(
      `/buckets/photos/policy?region=us-east-9&etag=${encodeURIComponent('"v1"')}`,
      { method: 'DELETE' },
    );
  });

  it('recognizes a write that lost to another writer', () => {
    expect(isPolicyConflict(failure(409, ApiErrorCode.POLICY_CONFLICT))).toBe(true);
    expect(isPolicyConflict(failure(409))).toBe(true);
    expect(isPolicyConflict(failure(400))).toBe(false);
    expect(isPolicyConflict(undefined)).toBe(false);
  });
});
