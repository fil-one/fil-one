import { describe, it, expect } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { policyOf, statement } from '../test/policy-statements.ts';
import { deleteBucketPolicy, getBucketPolicy, putBucketPolicy } from './s3-bucket-operations.ts';
import {
  BucketNotFoundError,
  PolicyNotFoundError,
  PolicyPublishError,
  PolicyValidationError,
} from './errors.ts';

const ALICE = '00000000-0000-0000-0000-00000000000a';
const BOB = '00000000-0000-0000-0000-00000000000b';

/**
 * These tests drive a real client through its whole stack with a request
 * handler that captures the HTTP request the signer produced and answers it,
 * so the S3 error codes are parsed as the SDK parses them.
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

const policy = policyOf(statement('photos', 'Allow', [ALICE], ['s3:GetObject']));

const readRequestBody = (request: CapturedRequest) =>
  typeof request.body === 'string'
    ? request.body
    : Buffer.from(request.body as Uint8Array).toString();

describe('PutBucketPolicy', () => {
  it('sends a PUT to ?policy with the policy as the JSON body', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = createS3ClientAnswering(captured, [{ statusCode: 204 }]);

    await putBucketPolicy(s3, 'photos', policy);

    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.method).toBe('PUT');
    expect(request.path).toMatch(/^\/photos\/?$/);
    expect(request.query).toHaveProperty('policy');
    expect(JSON.parse(readRequestBody(request))).toStrictEqual(policy);
  });

  it.each([
    { status: 404, code: 'NoSuchBucket', expected: BucketNotFoundError },
    { status: 404, code: 'NoSuchBucketPolicy', expected: PolicyNotFoundError },
    { status: 400, code: 'MalformedPolicy', expected: PolicyValidationError },
    { status: 500, code: 'InternalError', expected: PolicyPublishError },
    { status: 400, code: 'InvalidRequest', expected: Error },
  ])('maps S3 error $code to $expected.name', async ({ status, code, expected }) => {
    const s3 = createS3ClientAnswering([], [{ statusCode: status, body: buildS3ErrorXml(code) }]);
    await expect(putBucketPolicy(s3, 'photos', policy)).rejects.toBeInstanceOf(expected);
  });

  it('uses the MalformedPolicy message as the PolicyValidationError message', async () => {
    const s3 = createS3ClientAnswering(
      [],
      [{ statusCode: 400, body: buildS3ErrorXml('MalformedPolicy', `unknown principal "${BOB}"`) }],
    );
    await expect(putBucketPolicy(s3, 'photos', policy)).rejects.toMatchObject({
      name: 'PolicyValidationError',
      message: `unknown principal "${BOB}"`,
    });
  });
});

describe('GetBucketPolicy', () => {
  it('returns the document the gateway sent', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = createS3ClientAnswering(captured, [
      { statusCode: 200, body: JSON.stringify(policy) },
    ]);

    await expect(getBucketPolicy(s3, 'photos')).resolves.toStrictEqual(policy);
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
    await expect(deleteBucketPolicy(s3, 'photos')).resolves.toBeUndefined();
  });

  it('sends a DELETE to ?policy', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = createS3ClientAnswering(captured, [{ statusCode: 204 }]);

    await deleteBucketPolicy(s3, 'photos');

    expect(captured[0]).toMatchObject({ method: 'DELETE', query: { policy: expect.anything() } });
  });

  it('throws PolicyNotFoundError on NoSuchBucketPolicy', async () => {
    const s3 = createS3ClientAnswering(
      [],
      [{ statusCode: 404, body: buildS3ErrorXml('NoSuchBucketPolicy') }],
    );
    await expect(deleteBucketPolicy(s3, 'photos')).rejects.toBeInstanceOf(PolicyNotFoundError);
  });
});
