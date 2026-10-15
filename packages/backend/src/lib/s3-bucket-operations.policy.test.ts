import { describe, it, expect } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import type { BucketPolicy } from '@filone/shared';
import { deleteBucketPolicy, getBucketPolicy, putBucketPolicy } from './s3-bucket-operations.ts';
import {
  BucketNotFoundError,
  PolicyConflictError,
  PolicyNotFoundError,
  PolicyPreconditionFailedError,
  PolicyPublishError,
  PolicyValidationError,
} from './errors.ts';

const ALICE = '00000000-0000-0000-0000-00000000000a';
const BOB = '00000000-0000-0000-0000-00000000000b';

/**
 * The bucket policy operations put their preconditions in signed headers and
 * read the ETag off the response, both through command middleware, so these
 * tests drive a real client through its whole stack with a request handler
 * that captures the HTTP request the signer produced and answers it.
 */

interface CapturedRequest {
  method: string;
  path: string;
  query?: Record<string, string | null>;
  headers: Record<string, string>;
  body?: unknown;
}

interface CannedResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

function createS3ClientAnswering(captured: CapturedRequest[], answers: CannedResponse[]): S3Client {
  return new S3Client({
    endpoint: 'https://s3.example.test',
    region: 'us-east-9',
    credentials: { accessKeyId: 'AKIA0000TESTKEY0', secretAccessKey: 'secret' },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 1,
    requestHandler: {
      handle: async (request: CapturedRequest) => {
        captured.push(request);
        const { statusCode, headers = {}, body } = answers.shift() ?? { statusCode: 200 };
        return {
          response: {
            statusCode,
            headers,
            body: body === undefined ? undefined : Buffer.from(body),
          },
        };
      },
    },
  });
}

const buildS3ErrorXml = (code: string, message = code) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

const policy: BucketPolicy = {
  Statement: [{ Effect: 'Allow', Principal: [ALICE], Action: ['s3:GetObject'] }],
};

const readRequestBody = (request: CapturedRequest) =>
  typeof request.body === 'string'
    ? request.body
    : Buffer.from(request.body as Uint8Array).toString();

describe('PutBucketPolicy', () => {
  it('returns the ETag from the response header', async () => {
    const s3 = createS3ClientAnswering([], [{ statusCode: 204, headers: { etag: '"bafy-v2"' } }]);

    await expect(putBucketPolicy(s3, 'photos', policy, { ifMatch: '"bafy-v1"' })).resolves.toEqual({
      etag: '"bafy-v2"',
    });
  });

  it('sends a PUT to ?policy with the policy as the JSON body', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = createS3ClientAnswering(captured, [
      { statusCode: 204, headers: { etag: '"bafy-v2"' } },
    ]);

    await putBucketPolicy(s3, 'photos', policy, { ifMatch: '"bafy-v1"' });

    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.method).toBe('PUT');
    expect(request.path).toMatch(/^\/photos\/?$/);
    expect(request.query).toHaveProperty('policy');
    expect(JSON.parse(readRequestBody(request))).toStrictEqual(policy);
  });

  it('signs the If-Match header', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = createS3ClientAnswering(captured, [
      { statusCode: 204, headers: { etag: '"bafy-v2"' } },
    ]);

    await putBucketPolicy(s3, 'photos', policy, { ifMatch: '"bafy-v1"' });

    const headers = captured[0]!.headers;
    expect(headers['if-match'] ?? headers['If-Match']).toBe('"bafy-v1"');
    expect(headers.authorization).toMatch(/SignedHeaders=[^,]*if-match/);
  });

  it('sends a signed If-None-Match: * to create the first policy', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = createS3ClientAnswering(captured, [
      { statusCode: 204, headers: { etag: '"bafy-v1"' } },
    ]);

    await putBucketPolicy(s3, 'photos', policy, { ifNoneMatch: '*' });

    const headers = captured[0]!.headers;
    expect(headers['if-none-match'] ?? headers['If-None-Match']).toBe('*');
    expect(headers.authorization).toMatch(/SignedHeaders=[^,]*if-none-match/);
  });

  it('sends no precondition on an unconditional write', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = createS3ClientAnswering(captured, [
      { statusCode: 204, headers: { etag: '"bafy-v1"' } },
    ]);

    await putBucketPolicy(s3, 'photos', policy);

    const headers = Object.fromEntries(
      Object.entries(captured[0]!.headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    expect(headers).not.toHaveProperty('if-match');
    expect(headers).not.toHaveProperty('if-none-match');
  });

  it('throws when a successful write answers without an ETag header', async () => {
    const s3 = createS3ClientAnswering([], [{ statusCode: 204 }]);
    await expect(putBucketPolicy(s3, 'photos', policy, { ifNoneMatch: '*' })).rejects.toThrow(
      /without an ETag/,
    );
  });

  it.each([
    { status: 404, code: 'NoSuchBucket', expected: BucketNotFoundError },
    { status: 404, code: 'NoSuchBucketPolicy', expected: PolicyNotFoundError },
    { status: 412, code: 'PreconditionFailed', expected: PolicyPreconditionFailedError },
    { status: 409, code: 'OperationAborted', expected: PolicyConflictError },
    { status: 503, code: 'ServiceUnavailable', expected: PolicyConflictError },
    { status: 400, code: 'MalformedPolicy', expected: PolicyValidationError },
    { status: 500, code: 'InternalError', expected: PolicyPublishError },
    { status: 400, code: 'InvalidRequest', expected: Error },
  ])('maps S3 error $code to $expected.name', async ({ status, code, expected }) => {
    const s3 = createS3ClientAnswering([], [{ statusCode: status, body: buildS3ErrorXml(code) }]);
    await expect(putBucketPolicy(s3, 'photos', policy, { ifMatch: '"v1"' })).rejects.toBeInstanceOf(
      expected,
    );
  });

  it('uses the MalformedPolicy message as the PolicyValidationError message', async () => {
    const s3 = createS3ClientAnswering(
      [],
      [{ statusCode: 400, body: buildS3ErrorXml('MalformedPolicy', `unknown principal "${BOB}"`) }],
    );
    await expect(putBucketPolicy(s3, 'photos', policy, { ifMatch: '"v1"' })).rejects.toMatchObject({
      name: 'PolicyValidationError',
      message: `unknown principal "${BOB}"`,
    });
  });
});

describe('GetBucketPolicy', () => {
  it('returns the document with the ETag the gateway sent', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = createS3ClientAnswering(captured, [
      { statusCode: 200, headers: { etag: '"bafy-v1"' }, body: JSON.stringify(policy) },
    ]);

    await expect(getBucketPolicy(s3, 'photos')).resolves.toStrictEqual({
      policy,
      etag: '"bafy-v1"',
    });
    expect(captured[0]!.method).toBe('GET');
    expect(captured[0]!.query).toHaveProperty('policy');
  });

  it('returns null when the bucket has no policy', async () => {
    const s3 = createS3ClientAnswering(
      [],
      [{ statusCode: 404, body: buildS3ErrorXml('NoSuchBucketPolicy') }],
    );
    await expect(getBucketPolicy(s3, 'photos')).resolves.toBeNull();
  });

  it('throws BucketNotFoundError when the bucket does not exist', async () => {
    const s3 = createS3ClientAnswering(
      [],
      [{ statusCode: 404, body: buildS3ErrorXml('NoSuchBucket') }],
    );
    await expect(getBucketPolicy(s3, 'photos')).rejects.toBeInstanceOf(BucketNotFoundError);
  });

  it('throws a plain Error, not PolicyPublishError, when a read answers 500', async () => {
    const s3 = createS3ClientAnswering(
      [],
      [{ statusCode: 500, body: buildS3ErrorXml('InternalError') }],
    );
    const err: unknown = await getBucketPolicy(s3, 'photos').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PolicyPublishError);
    expect(err).toMatchObject({
      name: 'Error',
      message: 'Failed to read the policy of bucket "photos"',
    });
  });
});

describe('DeleteBucketPolicy', () => {
  it('resolves when the delete answers 204', async () => {
    const s3 = createS3ClientAnswering([], [{ statusCode: 204 }]);
    await expect(
      deleteBucketPolicy(s3, 'photos', { ifMatch: '"bafy-v1"' }),
    ).resolves.toBeUndefined();
  });

  it('sends a DELETE to ?policy with a signed If-Match', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = createS3ClientAnswering(captured, [{ statusCode: 204 }]);

    await deleteBucketPolicy(s3, 'photos', { ifMatch: '"bafy-v1"' });

    const request = captured[0]!;
    expect(request.method).toBe('DELETE');
    expect(request.query).toHaveProperty('policy');
    expect(request.headers['if-match'] ?? request.headers['If-Match']).toBe('"bafy-v1"');
    expect(request.headers.authorization).toMatch(/SignedHeaders=[^,]*if-match/);
  });

  it.each([
    { status: 404, code: 'NoSuchBucketPolicy', expected: PolicyNotFoundError },
    { status: 412, code: 'PreconditionFailed', expected: PolicyPreconditionFailedError },
  ])('throws $expected.name on $code', async ({ status, code, expected }) => {
    const s3 = createS3ClientAnswering([], [{ statusCode: status, body: buildS3ErrorXml(code) }]);
    await expect(deleteBucketPolicy(s3, 'photos', { ifMatch: '"v1"' })).rejects.toBeInstanceOf(
      expected,
    );
  });
});
