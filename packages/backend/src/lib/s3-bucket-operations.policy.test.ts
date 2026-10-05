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

function clientAnswering(captured: CapturedRequest[], answers: CannedResponse[]): S3Client {
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

const s3Error = (code: string, message = code) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

const policy: BucketPolicy = {
  Statement: [{ Effect: 'Allow', Principal: ['alice'], Action: ['s3:GetObject'] }],
};

const bodyOf = (request: CapturedRequest) =>
  typeof request.body === 'string'
    ? request.body
    : Buffer.from(request.body as Uint8Array).toString();

describe('PutBucketPolicy', () => {
  it('sends the document as the body with a signed If-Match and returns the ETag', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = clientAnswering(captured, [{ statusCode: 204, headers: { etag: '"bafy-v2"' } }]);

    await expect(putBucketPolicy(s3, 'photos', policy, { ifMatch: '"bafy-v1"' })).resolves.toEqual({
      etag: '"bafy-v2"',
    });

    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.method).toBe('PUT');
    expect(request.path).toMatch(/^\/photos\/?$/);
    expect(request.query).toHaveProperty('policy');
    expect(JSON.parse(bodyOf(request))).toStrictEqual(policy);
    expect(request.headers['if-match'] ?? request.headers['If-Match']).toBe('"bafy-v1"');
    expect(request.headers.authorization).toMatch(/SignedHeaders=[^,]*if-match/);
  });

  it('sends a signed If-None-Match: * to create the first policy', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = clientAnswering(captured, [{ statusCode: 204, headers: { etag: '"bafy-v1"' } }]);

    await putBucketPolicy(s3, 'photos', policy, { ifNoneMatch: '*' });

    const headers = captured[0]!.headers;
    expect(headers['if-none-match'] ?? headers['If-None-Match']).toBe('*');
    expect(headers.authorization).toMatch(/SignedHeaders=[^,]*if-none-match/);
  });

  it('refuses a 204 that carries no ETag', async () => {
    const s3 = clientAnswering([], [{ statusCode: 204 }]);
    await expect(putBucketPolicy(s3, 'photos', policy, { ifNoneMatch: '*' })).rejects.toThrow(
      /without an ETag/,
    );
  });

  it('maps each S3 error code to its policy error', async () => {
    const cases: Array<[number, string, unknown]> = [
      [404, 'NoSuchBucket', BucketNotFoundError],
      [404, 'NoSuchBucketPolicy', PolicyNotFoundError],
      [412, 'PreconditionFailed', PolicyPreconditionFailedError],
      [409, 'OperationAborted', PolicyConflictError],
      [503, 'ServiceUnavailable', PolicyConflictError],
      [400, 'MalformedPolicy', PolicyValidationError],
      [500, 'InternalError', PolicyPublishError],
      [400, 'InvalidRequest', Error],
    ];
    for (const [status, code, want] of cases) {
      const s3 = clientAnswering(
        [],
        [{ statusCode: status, body: s3Error(code, `refused: ${code}`) }],
      );
      const err: unknown = await putBucketPolicy(s3, 'photos', policy, { ifMatch: '"v1"' }).catch(
        (e: unknown) => e,
      );
      expect(err, code).toBeInstanceOf(want);
      if (want === PolicyValidationError)
        expect((err as Error).message).toBe('refused: MalformedPolicy');
    }
  });
});

describe('GetBucketPolicy', () => {
  it('returns the document with the ETag the gateway sent', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = clientAnswering(captured, [
      { statusCode: 200, headers: { etag: '"bafy-v1"' }, body: JSON.stringify(policy) },
    ]);

    await expect(getBucketPolicy(s3, 'photos')).resolves.toStrictEqual({
      policy,
      etag: '"bafy-v1"',
    });
    expect(captured[0]!.method).toBe('GET');
    expect(captured[0]!.query).toHaveProperty('policy');
  });

  it('answers null for a bucket without a policy and throws for a bucket that is not there', async () => {
    await expect(
      getBucketPolicy(
        clientAnswering([], [{ statusCode: 404, body: s3Error('NoSuchBucketPolicy') }]),
        'photos',
      ),
    ).resolves.toBeNull();
    await expect(
      getBucketPolicy(
        clientAnswering([], [{ statusCode: 404, body: s3Error('NoSuchBucket') }]),
        'photos',
      ),
    ).rejects.toBeInstanceOf(BucketNotFoundError);
  });

  it('treats a 500 on a read as an ordinary failure', async () => {
    const err: unknown = await getBucketPolicy(
      clientAnswering([], [{ statusCode: 500, body: s3Error('InternalError') }]),
      'photos',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PolicyPublishError);
  });
});

describe('DeleteBucketPolicy', () => {
  it('sends a signed If-Match and treats 204 as done', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = clientAnswering(captured, [{ statusCode: 204 }]);

    await expect(
      deleteBucketPolicy(s3, 'photos', { ifMatch: '"bafy-v1"' }),
    ).resolves.toBeUndefined();
    const request = captured[0]!;
    expect(request.method).toBe('DELETE');
    expect(request.query).toHaveProperty('policy');
    expect(request.headers['if-match'] ?? request.headers['If-Match']).toBe('"bafy-v1"');
    expect(request.headers.authorization).toMatch(/SignedHeaders=[^,]*if-match/);
  });

  it('reports a bucket without a policy and a stale tag', async () => {
    await expect(
      deleteBucketPolicy(
        clientAnswering([], [{ statusCode: 404, body: s3Error('NoSuchBucketPolicy') }]),
        'photos',
        { ifMatch: '"v1"' },
      ),
    ).rejects.toBeInstanceOf(PolicyNotFoundError);
    await expect(
      deleteBucketPolicy(
        clientAnswering([], [{ statusCode: 412, body: s3Error('PreconditionFailed') }]),
        'photos',
        { ifMatch: '"v1"' },
      ),
    ).rejects.toBeInstanceOf(PolicyPreconditionFailedError);
  });
});
