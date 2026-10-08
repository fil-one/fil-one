import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiErrorCode, S3Region } from '@filone/shared';
import type { BucketPolicy } from '@filone/shared';

const mockApiResponse = vi.fn();
vi.mock('./api.js', async () => ({
  ...(await vi.importActual<typeof import('./api.js')>('./api.js')),
  apiResponse: (...args: unknown[]) => mockApiResponse(...args),
}));

import {
  deleteBucketPolicy,
  getBucketPolicy,
  isPolicyConflict,
  putBucketPolicy,
} from './bucket-policy-api.js';

const policy: BucketPolicy = {
  Statement: [{ Effect: 'Allow', Principal: ['user-1'], Action: ['s3:GetObject'] }],
};
const failure = (status: number, code?: string) =>
  Object.assign(new Error('refused'), { status, ...(code ? { code } : {}) });
const answer = (status: number, etag?: string, body?: object) =>
  new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: etag ? { ETag: etag } : {},
  });
const PATH = '/buckets/photos/policy?region=us-east-9';

describe('bucket policy client', () => {
  beforeEach(() => {
    mockApiResponse.mockReset();
  });

  it('reads the policy with its ETag header from the bucket route', async () => {
    mockApiResponse.mockResolvedValue(answer(200, '"v1"', { policy }));

    await expect(getBucketPolicy('photos', S3Region.UsEast9)).resolves.toStrictEqual({
      policy,
      etag: '"v1"',
    });
    expect(mockApiResponse).toHaveBeenCalledWith(PATH);
  });

  it('reads a bucket with no policy as null, and lets every other failure through', async () => {
    mockApiResponse.mockRejectedValueOnce(failure(404, ApiErrorCode.POLICY_NOT_FOUND));
    await expect(getBucketPolicy('photos', S3Region.UsEast9)).resolves.toBeNull();

    mockApiResponse.mockRejectedValueOnce(failure(404));
    await expect(getBucketPolicy('photos', S3Region.UsEast9)).rejects.toThrow('refused');
  });

  it('writes under If-Match with the etag it read, creates under If-None-Match: *, and answers the new ETag', async () => {
    mockApiResponse.mockResolvedValue(answer(204, '"v2"'));

    await expect(
      putBucketPolicy('photos', S3Region.UsEast9, { policy, etag: '"v1"' }),
    ).resolves.toStrictEqual({ etag: '"v2"' });
    await putBucketPolicy('photos', S3Region.UsEast9, { policy });

    expect(mockApiResponse.mock.calls).toStrictEqual([
      [PATH, { method: 'PUT', headers: { 'If-Match': '"v1"' }, body: JSON.stringify({ policy }) }],
      [
        PATH,
        { method: 'PUT', headers: { 'If-None-Match': '*' }, body: JSON.stringify({ policy }) },
      ],
    ]);
  });

  it('refuses a write answered without an ETag', async () => {
    mockApiResponse.mockResolvedValue(answer(204));

    await expect(putBucketPolicy('photos', S3Region.UsEast9, { policy })).rejects.toThrow(
      /no ETag/,
    );
  });

  it('removes the policy under If-Match with the etag it read', async () => {
    mockApiResponse.mockResolvedValue(answer(204));

    await deleteBucketPolicy('photos', S3Region.UsEast9, '"v1"');

    expect(mockApiResponse).toHaveBeenCalledWith(PATH, {
      method: 'DELETE',
      headers: { 'If-Match': '"v1"' },
    });
  });

  it('recognizes a write that lost to another writer', () => {
    expect(isPolicyConflict(failure(412, ApiErrorCode.POLICY_CONFLICT))).toBe(true);
    expect(isPolicyConflict(failure(412))).toBe(true);
    expect(isPolicyConflict(failure(409))).toBe(true);
    expect(isPolicyConflict(failure(400))).toBe(false);
    expect(isPolicyConflict(undefined)).toBe(false);
  });
});
