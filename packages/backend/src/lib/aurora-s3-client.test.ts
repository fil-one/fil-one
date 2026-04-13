import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { S3Region } from '@filone/shared';

import {
  getAuroraS3Client,
  _resetS3ClientCacheForTesting,
  _resetSsmCacheForTesting,
} from './aurora-s3-client.js';

const ssmMock = mockClient(SSMClient);

function resolveSsmWithCredentials(accessKeyId: string, secretAccessKey: string) {
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: JSON.stringify({ accessKeyId, secretAccessKey }) },
  });
}

describe('getAuroraS3Client', () => {
  beforeEach(() => {
    ssmMock.reset();
    _resetS3ClientCacheForTesting();
    _resetSsmCacheForTesting();
  });

  it('returns the same instance for the same (stage, region, tenantId)', () => {
    const a = getAuroraS3Client('dev', S3Region.EuWest1, 'tenant-1');
    const b = getAuroraS3Client('dev', S3Region.EuWest1, 'tenant-1');
    expect(a).toBe(b);
  });

  it('returns distinct instances for different tenants', () => {
    const a = getAuroraS3Client('dev', S3Region.EuWest1, 'tenant-1');
    const b = getAuroraS3Client('dev', S3Region.EuWest1, 'tenant-2');
    expect(a).not.toBe(b);
  });

  it('returns distinct instances for different stages', () => {
    const a = getAuroraS3Client('dev', S3Region.EuWest1, 'tenant-1');
    const b = getAuroraS3Client('production', S3Region.EuWest1, 'tenant-1');
    expect(a).not.toBe(b);
  });

  it('returns distinct instances for different regions', () => {
    const a = getAuroraS3Client('dev', S3Region.EuWest1, 'tenant-1');
    // Cast is used because the enum currently has only one value; a second
    // region is coming soon per FIL-121.
    const b = getAuroraS3Client('dev', 'us-east-1' as S3Region, 'tenant-1');
    expect(a).not.toBe(b);
  });

  it("configures the client's endpoint from getS3Endpoint(region, stage)", async () => {
    const client = getAuroraS3Client('production', S3Region.EuWest1, 'tenant-1');
    // `endpoint` is an async provider returning an Endpoint-shaped object.
    const endpoint = await (
      client.config.endpoint as () => Promise<{
        protocol: string;
        hostname: string;
      }>
    )();
    expect(`${endpoint.protocol}//${endpoint.hostname}`).toBe('https://eu-west-1.s3.fil.one');
  });

  it("resolves credentials via getAuroraS3Credentials for the client's tenant", async () => {
    resolveSsmWithCredentials('AKIA_TENANT_1', 'secret-1');
    const client = getAuroraS3Client('dev', S3Region.EuWest1, 'tenant-1');
    const creds = await (
      client.config.credentials as () => Promise<{
        accessKeyId: string;
        secretAccessKey: string;
      }>
    )();
    expect(creds).toStrictEqual({
      accessKeyId: 'AKIA_TENANT_1',
      secretAccessKey: 'secret-1',
    });
  });

  it('fetches SSM credentials for the tenant associated with the client', async () => {
    resolveSsmWithCredentials('AKIA', 'secret');
    const client = getAuroraS3Client('dev', S3Region.EuWest1, 'tenant-42');
    await (client.config.credentials as () => Promise<unknown>)();
    const ssmCalls = ssmMock.commandCalls(GetParameterCommand);
    expect(ssmCalls[0].args[0].input).toStrictEqual({
      Name: '/filone/dev/aurora-s3/access-key/tenant-42',
      WithDecryption: true,
    });
  });

  it('evicts the oldest entry when the cache overflows its 500-entry cap', () => {
    const first = getAuroraS3Client('dev', S3Region.EuWest1, 'tenant-0');
    // QuickLRU uses two internal maps of size <= maxSize. Inserting 1000 more
    // entries (1001 total) forces two rotations, guaranteeing tenant-0 is
    // evicted.
    for (let i = 1; i <= 1000; i += 1) {
      getAuroraS3Client('dev', S3Region.EuWest1, `tenant-${i}`);
    }
    const firstAgain = getAuroraS3Client('dev', S3Region.EuWest1, 'tenant-0');
    expect(firstAgain).not.toBe(first);
  });
});
