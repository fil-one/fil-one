import { describe, it, expect } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { createS3Client } from './s3-client.js';
import type { S3ClientContext } from './s3-client.js';

const ctx: S3ClientContext = {
  endpointUrl: 'https://s3.example.com',
  region: 'us-east-1',
  credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
  forcePathStyle: true,
};

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
});
