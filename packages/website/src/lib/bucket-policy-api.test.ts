import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiErrorCode, POLICY_VERSION, S3Region, buildStatement } from '@filone/shared';
import type { BucketPolicy } from '@filone/shared';

const mockSendApiRequest = vi.fn();
vi.mock('./api.js', async () => ({
  ...(await vi.importActual<typeof import('./api.js')>('./api.js')),
  sendApiRequest: (...args: unknown[]) => mockSendApiRequest(...args),
}));

import {
  deleteBucketPolicy,
  getBucketPolicy,
  isPolicyConflict,
  putBucketPolicy,
} from './bucket-policy-api.js';

const USER_1 = '00000000-0000-0000-0000-000000000001';

const policy: BucketPolicy = {
  Version: POLICY_VERSION,
  Statement: [
    buildStatement({ bucketName: 'photos', principal: [USER_1], actions: ['s3:GetObject'] }),
  ],
};
const createApiError = (status: number, code?: string) =>
  Object.assign(new Error('refused'), { status, ...(code ? { code } : {}) });
const createPolicyResponse = (status: number, etag?: string, body?: object) =>
  new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: etag ? { ETag: etag } : {},
  });
const POLICY_PATH = '/buckets/photos/policy?region=us-east-9';

describe('bucket policy client', () => {
  beforeEach(() => {
    mockSendApiRequest.mockReset();
  });

  it('returns the policy and the ETag header from GET /buckets/:name/policy', async () => {
    mockSendApiRequest.mockResolvedValue(createPolicyResponse(200, '"v1"', { policy }));

    await expect(getBucketPolicy('photos', S3Region.UsEast9)).resolves.toStrictEqual({
      policy,
      etag: '"v1"',
    });
    expect(mockSendApiRequest).toHaveBeenCalledWith(POLICY_PATH);
  });

  it('URL-encodes the bucket name in the path', async () => {
    mockSendApiRequest.mockResolvedValue(createPolicyResponse(200, '"v1"', { policy }));

    await getBucketPolicy('my photos/2026', S3Region.UsEast9);

    expect(mockSendApiRequest).toHaveBeenCalledWith(
      '/buckets/my%20photos%2F2026/policy?region=us-east-9',
    );
  });

  it('returns null when the API answers POLICY_NOT_FOUND', async () => {
    mockSendApiRequest.mockRejectedValue(createApiError(404, ApiErrorCode.POLICY_NOT_FOUND));

    await expect(getBucketPolicy('photos', S3Region.UsEast9)).resolves.toBeNull();
  });

  it('rethrows a 404 without POLICY_NOT_FOUND', async () => {
    mockSendApiRequest.mockRejectedValue(createApiError(404));

    await expect(getBucketPolicy('photos', S3Region.UsEast9)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('throws when the GET response has no ETag header', async () => {
    mockSendApiRequest.mockResolvedValue(createPolicyResponse(200, undefined, { policy }));

    await expect(getBucketPolicy('photos', S3Region.UsEast9)).rejects.toThrow(/no ETag/);
  });

  it('sends If-Match with the ETag it read', async () => {
    mockSendApiRequest.mockResolvedValue(createPolicyResponse(204, '"v2"'));

    await putBucketPolicy('photos', S3Region.UsEast9, { policy, etag: '"v1"' });

    expect(mockSendApiRequest).toHaveBeenCalledWith(POLICY_PATH, {
      method: 'PUT',
      headers: { 'If-Match': '"v1"' },
      body: JSON.stringify({ policy }),
    });
  });

  it('sends If-None-Match: * when no ETag is given', async () => {
    mockSendApiRequest.mockResolvedValue(createPolicyResponse(204, '"v1"'));

    await putBucketPolicy('photos', S3Region.UsEast9, { policy });

    expect(mockSendApiRequest).toHaveBeenCalledWith(POLICY_PATH, {
      method: 'PUT',
      headers: { 'If-None-Match': '*' },
      body: JSON.stringify({ policy }),
    });
  });

  it('returns the ETag from the response', async () => {
    mockSendApiRequest.mockResolvedValue(createPolicyResponse(204, '"v2"'));

    await expect(
      putBucketPolicy('photos', S3Region.UsEast9, { policy, etag: '"v1"' }),
    ).resolves.toStrictEqual({ etag: '"v2"' });
  });

  it('throws when the PUT response has no ETag header', async () => {
    mockSendApiRequest.mockResolvedValue(createPolicyResponse(204));

    await expect(putBucketPolicy('photos', S3Region.UsEast9, { policy })).rejects.toThrow(
      /no ETag/,
    );
  });

  it('sends DELETE with If-Match set to the given ETag', async () => {
    mockSendApiRequest.mockResolvedValue(createPolicyResponse(204));

    await deleteBucketPolicy('photos', S3Region.UsEast9, '"v1"');

    expect(mockSendApiRequest).toHaveBeenCalledWith(POLICY_PATH, {
      method: 'DELETE',
      headers: { 'If-Match': '"v1"' },
    });
  });

  it.each([
    { error: { status: 412, code: ApiErrorCode.POLICY_CONFLICT }, expected: true },
    { error: { status: 412 }, expected: true },
    { error: { status: 409 }, expected: true },
    { error: { status: 400 }, expected: false },
    { error: undefined, expected: false },
  ])('isPolicyConflict returns $expected for $error', ({ error, expected }) => {
    expect(isPolicyConflict(error)).toBe(expected);
  });
});
