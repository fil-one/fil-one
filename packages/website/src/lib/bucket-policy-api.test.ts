import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiErrorCode, POLICY_VERSION, S3Region, buildStatement } from '@filone/shared';
import type { BucketPolicy } from '@filone/shared';

const mockApiRequest = vi.fn();
vi.mock('./api.js', async () => ({
  ...(await vi.importActual<typeof import('./api.js')>('./api.js')),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

import { deleteBucketPolicy, getBucketPolicy, putBucketPolicy } from './bucket-policy-api.js';

const USER_1 = '00000000-0000-0000-0000-000000000001';

const policy: BucketPolicy = {
  Version: POLICY_VERSION,
  Statement: [
    buildStatement({ bucketName: 'photos', principal: [USER_1], actions: ['s3:GetObject'] }),
  ],
};
const createApiError = (status: number, code?: string) =>
  Object.assign(new Error('refused'), { status, ...(code ? { code } : {}) });
const POLICY_PATH = '/buckets/photos/policy?region=us-east-9';

describe('bucket policy client', () => {
  beforeEach(() => {
    mockApiRequest.mockReset();
  });

  it('returns the policy from GET /buckets/:name/policy', async () => {
    mockApiRequest.mockResolvedValue({ policy });

    await expect(getBucketPolicy('photos', S3Region.UsEast9)).resolves.toStrictEqual({ policy });
    expect(mockApiRequest).toHaveBeenCalledWith(POLICY_PATH);
  });

  it('URL-encodes the bucket name in the path', async () => {
    mockApiRequest.mockResolvedValue({ policy });

    await getBucketPolicy('my photos/2026', S3Region.UsEast9);

    expect(mockApiRequest).toHaveBeenCalledWith(
      '/buckets/my%20photos%2F2026/policy?region=us-east-9',
    );
  });

  it('returns null when the API answers POLICY_NOT_FOUND', async () => {
    mockApiRequest.mockRejectedValue(createApiError(404, ApiErrorCode.POLICY_NOT_FOUND));

    await expect(getBucketPolicy('photos', S3Region.UsEast9)).resolves.toBeNull();
  });

  it('rethrows a 404 without POLICY_NOT_FOUND', async () => {
    mockApiRequest.mockRejectedValue(createApiError(404));

    await expect(getBucketPolicy('photos', S3Region.UsEast9)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('sends the policy in a PUT with no precondition header', async () => {
    mockApiRequest.mockResolvedValue(undefined);

    await putBucketPolicy('photos', S3Region.UsEast9, policy);

    expect(mockApiRequest).toHaveBeenCalledWith(POLICY_PATH, {
      method: 'PUT',
      body: JSON.stringify({ policy }),
    });
  });

  it('sends a DELETE with no precondition header', async () => {
    mockApiRequest.mockResolvedValue(undefined);

    await deleteBucketPolicy('photos', S3Region.UsEast9);

    expect(mockApiRequest).toHaveBeenCalledWith(POLICY_PATH, { method: 'DELETE' });
  });
});
