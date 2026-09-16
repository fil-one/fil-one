import { describe, it, expect } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import type { BucketPolicy } from '@filone/shared';
import {
  BUCKET_POLICY_HEADER,
  createBucket,
  encodeBucketPolicyHeader,
} from './s3-bucket-operations.ts';
import { PolicyValidationError } from './errors.ts';

/**
 * Apart from the other S3 operation tests, which stub `send` on every client
 * and so never run a command's middleware. The policy header is added by
 * middleware and has to be signed, so this file drives a real client through
 * its whole stack, with a request handler that captures the HTTP request the
 * signer produced and answers it.
 */

interface CapturedRequest {
  headers: Record<string, string>;
}

function clientCapturing(
  captured: CapturedRequest[],
  respond: () => { statusCode: number; body?: string } = () => ({ statusCode: 200 }),
): S3Client {
  return new S3Client({
    endpoint: 'https://s3.example.test',
    region: 'us-east-9',
    credentials: { accessKeyId: 'AKIA0000TESTKEY0', secretAccessKey: 'secret' },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: {
      handle: async (request: CapturedRequest) => {
        captured.push(request);
        const { statusCode, body } = respond();
        return {
          response: {
            statusCode,
            headers: {},
            body: body === undefined ? undefined : Buffer.from(body),
          },
        };
      },
    },
  });
}

const policy: BucketPolicy = {
  statement: [{ effect: 'allow', principal: ['alice'], action: ['s3:GetObject'] }],
};

describe('the x-bucket-policy header on CreateBucket', () => {
  it('carries the base64 JSON document and is signed with the request', async () => {
    const captured: CapturedRequest[] = [];

    await createBucket(clientCapturing(captured), { bucketName: 'photos', policy });

    expect(captured).toHaveLength(1);
    const headers = captured[0]!.headers;
    expect(headers[BUCKET_POLICY_HEADER]).toBe(encodeBucketPolicyHeader(policy));
    expect(
      JSON.parse(Buffer.from(headers[BUCKET_POLICY_HEADER]!, 'base64').toString()),
    ).toStrictEqual(policy);
    // SigV4 lists the signed headers in the Authorization header; an unsigned
    // policy header is refused by the storage system.
    expect(headers.authorization).toMatch(/SignedHeaders=[^,]*x-bucket-policy/);
  });

  it('sends no policy header when the create carries no policy', async () => {
    const captured: CapturedRequest[] = [];

    await createBucket(clientCapturing(captured), { bucketName: 'photos' });

    expect(captured[0]!.headers).not.toHaveProperty(BUCKET_POLICY_HEADER);
  });

  it('maps a refused policy to PolicyValidationError', async () => {
    const captured: CapturedRequest[] = [];
    const s3 = clientCapturing(captured, () => ({
      statusCode: 400,
      body: '<Error><Code>InvalidArgument</Code><Message>invalid bucket policy</Message></Error>',
    }));

    await expect(createBucket(s3, { bucketName: 'photos', policy })).rejects.toBeInstanceOf(
      PolicyValidationError,
    );
  });
});
