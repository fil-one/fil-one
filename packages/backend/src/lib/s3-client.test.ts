import { describe, it, expect } from 'vitest';
import { GetBucketVersioningCommand, S3Client } from '@aws-sdk/client-s3';
import { createS3Client } from './s3-client.js';
import type { S3ClientContext } from './s3-client.js';

const ctx: S3ClientContext = {
  endpointUrl: 'https://s3.example.com',
  region: 'us-east-1',
  credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
  forcePathStyle: true,
  orchestratorId: 'fth',
  tenantId: 't-123',
};

/**
 * Route the client's HTTP layer to a stub that fails with the given error, so
 * a send() exercises the real middleware stack (unlike aws-sdk-client-mock,
 * which replaces send() entirely and bypasses middleware).
 */
function failRequestsWith(client: S3Client, error: Error): void {
  client.config.requestHandler = {
    handle: async () => {
      throw error;
    },
  } as unknown as typeof client.config.requestHandler;
}

function accessDeniedError(): Error {
  return Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
}

describe('createS3Client', () => {
  it('returns an S3Client instance', () => {
    expect(createS3Client(ctx)).toBeInstanceOf(S3Client);
  });

  it('wires the context region, credentials, path-style, and endpoint into the client config', async () => {
    const client = createS3Client(ctx);

    expect(await client.config.region()).toBe('us-east-1');
    expect(client.config.forcePathStyle).toBe(true);

    const credentials = await client.config.credentials();
    expect(credentials).toMatchObject({ accessKeyId: 'AK', secretAccessKey: 'SK' });

    const endpoint = await client.config.endpoint!();
    expect(endpoint.hostname).toBe('s3.example.com');
    expect(endpoint.protocol).toBe('https:');
  });

  it('disables auto checksum calculation/validation by setting WHEN_REQUIRED in the S3 client config', async () => {
    const client = createS3Client(ctx);

    // The SDK normalizes these into async providers.
    expect(await client.config.requestChecksumCalculation()).toBe('WHEN_REQUIRED');
    expect(await client.config.responseChecksumValidation()).toBe('WHEN_REQUIRED');
  });

  it('forwards a custom region and disabled path-style', async () => {
    const client = createS3Client({
      ...ctx,
      region: 'auto',
      forcePathStyle: false,
    });

    expect(await client.config.region()).toBe('auto');
    expect(client.config.forcePathStyle).toBe(false);
  });

  describe('error decoration', () => {
    it('attaches operation, bucket, and client context as an s3Context property', async () => {
      const client = createS3Client(ctx);
      failRequestsWith(client, accessDeniedError());

      await expect(
        client.send(new GetBucketVersioningCommand({ Bucket: 'my-bucket' })),
      ).rejects.toMatchObject({
        s3Context: {
          operation: 'GetBucketVersioning',
          bucketName: 'my-bucket',
          tenantId: 't-123',
          orchestratorId: 'fth',
          region: 'us-east-1',
          endpointUrl: 'https://s3.example.com',
        },
      });
    });

    it('leaves the error message unchanged so persisted/user-facing text cannot leak the context', async () => {
      const client = createS3Client(ctx);
      failRequestsWith(client, accessDeniedError());

      await expect(
        client.send(new GetBucketVersioningCommand({ Bucket: 'my-bucket' })),
      ).rejects.toMatchObject({ message: 'Access Denied' });
    });

    it('preserves the original error name so callers can keep matching on it', async () => {
      const client = createS3Client(ctx);
      failRequestsWith(client, accessDeniedError());

      await expect(
        client.send(new GetBucketVersioningCommand({ Bucket: 'my-bucket' })),
      ).rejects.toMatchObject({ name: 'AccessDenied' });
    });

    it('rethrows the same error instance rather than wrapping it', async () => {
      const client = createS3Client(ctx);
      const original = accessDeniedError();
      failRequestsWith(client, original);

      await expect(
        client.send(new GetBucketVersioningCommand({ Bucket: 'my-bucket' })),
      ).rejects.toBe(original);
    });
  });
});
