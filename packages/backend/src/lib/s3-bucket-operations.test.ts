import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateBucketCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  GetObjectLockConfigurationCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  PutObjectLockConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import {
  createBucket,
  getBucketObjectLock,
  getBucketVersioning,
  getObjectBytes,
  listBuckets,
  listObjects,
  putObjectLockConfiguration,
  setBucketVersioning,
} from './s3-bucket-operations.js';
import { createS3Client } from './s3-client.js';
import { BucketAlreadyExistsError } from './errors.js';
import type { S3ClientContext } from './s3-client.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const s3Mock = mockClient(S3Client);

// The operations under test take a ready-built S3Client. aws-sdk-client-mock
// intercepts every S3Client instance, so a client built from any context works.
const s3 = createS3Client({
  endpointUrl: 'https://s3.example.com',
  region: 'auto',
  credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
  forcePathStyle: true,
  orchestratorId: 'test',
  tenantId: 't-1',
} satisfies S3ClientContext);

// ---------------------------------------------------------------------------
// Direct operations
// ---------------------------------------------------------------------------

describe('s3 bucket operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3Mock.reset();
  });

  describe('createBucket', () => {
    it('sends a CreateBucketCommand with the supplied bucket name', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});

      await createBucket(s3, { bucketName: 'my-bucket' });

      const calls = s3Mock.commandCalls(CreateBucketCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({ Bucket: 'my-bucket' });
    });

    it('sends ObjectLockEnabledForBucket:true when objectLockEnabled is set', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});

      await createBucket(s3, { bucketName: 'my-bucket', objectLockEnabled: true });

      const calls = s3Mock.commandCalls(CreateBucketCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({
        Bucket: 'my-bucket',
        ObjectLockEnabledForBucket: true,
      });
    });

    const alreadyExistsNames = ['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'];
    for (const errName of alreadyExistsNames) {
      it(`maps SDK error "${errName}" to BucketAlreadyExistsError`, async () => {
        const sdkErr = Object.assign(new Error('already there'), { name: errName });
        s3Mock.on(CreateBucketCommand).rejects(sdkErr);

        await expect(createBucket(s3, { bucketName: 'my-bucket' })).rejects.toBeInstanceOf(
          BucketAlreadyExistsError,
        );
      });
    }

    it('attaches the original SDK error as the cause of BucketAlreadyExistsError', async () => {
      const sdkErr = Object.assign(new Error('already there'), { name: 'BucketAlreadyExists' });
      s3Mock.on(CreateBucketCommand).rejects(sdkErr);

      await expect(createBucket(s3, { bucketName: 'my-bucket' })).rejects.toMatchObject({
        cause: sdkErr,
      });
    });

    it('propagates unrelated SDK errors unchanged', async () => {
      const sdkErr = Object.assign(new Error('denied'), { name: 'AccessDenied' });
      s3Mock.on(CreateBucketCommand).rejects(sdkErr);

      await expect(createBucket(s3, { bucketName: 'my-bucket' })).rejects.toBe(sdkErr);
    });
  });

  describe('listBuckets', () => {
    it('returns buckets with createdAt timestamps', async () => {
      const date = new Date('2026-01-01T00:00:00Z');
      s3Mock.on(ListBucketsCommand).resolves({
        Buckets: [
          { Name: 'a', CreationDate: date },
          { Name: 'b', CreationDate: date },
        ],
      });

      const result = await listBuckets(s3);

      expect(result.buckets).toEqual([
        { name: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
        { name: 'b', createdAt: '2026-01-01T00:00:00.000Z' },
      ]);
    });

    it('falls back to a current timestamp when CreationDate is missing', async () => {
      s3Mock.on(ListBucketsCommand).resolves({ Buckets: [{ Name: 'a' }] });

      const result = await listBuckets(s3);

      expect(result.buckets[0]?.name).toBe('a');
      expect(typeof result.buckets[0]?.createdAt).toBe('string');
      expect(Number.isNaN(Date.parse(result.buckets[0]!.createdAt))).toBe(false);
    });

    it('returns an empty array when no buckets exist', async () => {
      s3Mock.on(ListBucketsCommand).resolves({});

      const result = await listBuckets(s3);

      expect(result).toEqual({ buckets: [] });
    });
  });

  describe('listObjects', () => {
    it('maps S3 Contents into S3Object shape', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [
          {
            Key: 'a.txt',
            Size: 12,
            LastModified: new Date('2026-01-01T00:00:00Z'),
            ETag: '"abc"',
          },
        ],
        IsTruncated: false,
      });

      const result = await listObjects({ s3, bucket: 'my-bucket' });

      expect(result).toEqual({
        objects: [
          {
            key: 'a.txt',
            sizeBytes: 12,
            lastModified: '2026-01-01T00:00:00.000Z',
            etag: '"abc"',
          },
        ],
        nextToken: undefined,
        isTruncated: false,
      });
    });

    it('forwards prefix, delimiter, maxKeys, continuationToken when present', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });

      await listObjects({
        s3,
        bucket: 'my-bucket',
        prefix: 'docs/',
        delimiter: '/',
        maxKeys: 50,
        continuationToken: 'next-page',
      });

      const calls = s3Mock.commandCalls(ListObjectsV2Command);
      expect(calls[0].args[0].input).toEqual({
        Bucket: 'my-bucket',
        Prefix: 'docs/',
        Delimiter: '/',
        MaxKeys: 50,
        ContinuationToken: 'next-page',
      });
    });

    it('returns nextToken and isTruncated when S3 paginates', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [],
        IsTruncated: true,
        NextContinuationToken: 'page-2',
      });

      const result = await listObjects({ s3, bucket: 'my-bucket' });

      expect(result.nextToken).toBe('page-2');
      expect(result.isTruncated).toBe(true);
    });

    it('handles entries with missing optional fields', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: 'a.txt' }],
      });

      const result = await listObjects({ s3, bucket: 'my-bucket' });

      expect(result.objects[0]).toMatchObject({ key: 'a.txt', sizeBytes: 0 });
      expect(typeof result.objects[0]?.lastModified).toBe('string');
      expect(result.objects[0]?.etag).toBeUndefined();
    });
  });

  describe('getObjectBytes', () => {
    // The helper only touches Body.transformToByteArray(); model that one method
    // and present it as the SDK's Body type without resorting to `any`.
    function body(bytes: Uint8Array): GetObjectCommandOutput['Body'] {
      return {
        transformToByteArray: vi.fn().mockResolvedValue(bytes),
      } as unknown as GetObjectCommandOutput['Body'];
    }

    it('returns the object bytes and stored content type', async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      s3Mock.on(GetObjectCommand).resolves({ Body: body(bytes), ContentType: 'application/pdf' });

      const result = await getObjectBytes(s3, 'my-bucket', 'doc.pdf');

      const input = s3Mock.commandCalls(GetObjectCommand)[0].args[0].input;
      expect(input).toEqual({ Bucket: 'my-bucket', Key: 'doc.pdf' });
      expect(result.bytes).toEqual(bytes);
      expect(result.contentType).toBe('application/pdf');
    });

    it('omits the content type when S3 reports none', async () => {
      s3Mock.on(GetObjectCommand).resolves({ Body: body(new Uint8Array([9])) });

      const result = await getObjectBytes(s3, 'my-bucket', 'a.txt');

      expect(result.contentType).toBeUndefined();
    });

    it('throws when the object body is empty', async () => {
      s3Mock.on(GetObjectCommand).resolves({});

      await expect(getObjectBytes(s3, 'my-bucket', 'a.txt')).rejects.toThrow(/empty body/);
    });
  });

  describe('setBucketVersioning', () => {
    it('sends Status Enabled when enabled defaults to true', async () => {
      s3Mock.on(PutBucketVersioningCommand).resolves({});

      await setBucketVersioning(s3, 'my-bucket');

      const calls = s3Mock.commandCalls(PutBucketVersioningCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({
        Bucket: 'my-bucket',
        VersioningConfiguration: { Status: 'Enabled' },
      });
    });

    it('sends Status Suspended when enabled is false', async () => {
      s3Mock.on(PutBucketVersioningCommand).resolves({});

      await setBucketVersioning(s3, 'my-bucket', false);

      const calls = s3Mock.commandCalls(PutBucketVersioningCommand);
      expect(calls[0].args[0].input).toEqual({
        Bucket: 'my-bucket',
        VersioningConfiguration: { Status: 'Suspended' },
      });
    });
  });

  describe('putObjectLockConfiguration', () => {
    it('maps governance + days duration to a Days rule', async () => {
      s3Mock.on(PutObjectLockConfigurationCommand).resolves({});

      await putObjectLockConfiguration(s3, {
        bucketName: 'my-bucket',
        mode: 'governance',
        duration: 7,
        durationType: 'd',
      });

      const calls = s3Mock.commandCalls(PutObjectLockConfigurationCommand);
      expect(calls).toHaveLength(1);
      const cfg = calls[0].args[0].input.ObjectLockConfiguration;
      expect(cfg?.ObjectLockEnabled).toBe('Enabled');
      const retention = cfg?.Rule?.DefaultRetention;
      expect(retention?.Mode).toBe('GOVERNANCE');
      expect(retention?.Days).toBe(7);
      expect(retention?.Years).toBeUndefined();
    });

    it('maps compliance + years duration to a Years rule', async () => {
      s3Mock.on(PutObjectLockConfigurationCommand).resolves({});

      await putObjectLockConfiguration(s3, {
        bucketName: 'my-bucket',
        mode: 'compliance',
        duration: 1,
        durationType: 'y',
      });

      const calls = s3Mock.commandCalls(PutObjectLockConfigurationCommand);
      const retention = calls[0].args[0].input.ObjectLockConfiguration?.Rule?.DefaultRetention;
      expect(retention?.Mode).toBe('COMPLIANCE');
      expect(retention?.Years).toBe(1);
      expect(retention?.Days).toBeUndefined();
    });
  });

  describe('getBucketVersioning', () => {
    it('returns true when Status is Enabled', async () => {
      s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });

      expect(await getBucketVersioning(s3, 'my-bucket')).toBe(true);
    });

    it('returns false when Status is Suspended', async () => {
      s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Suspended' });

      expect(await getBucketVersioning(s3, 'my-bucket')).toBe(false);
    });

    it('returns false when Status is undefined', async () => {
      s3Mock.on(GetBucketVersioningCommand).resolves({});

      expect(await getBucketVersioning(s3, 'my-bucket')).toBe(false);
    });
  });

  describe('getBucketObjectLock', () => {
    it('parses an enabled config with a governance days rule', async () => {
      s3Mock.on(GetObjectLockConfigurationCommand).resolves({
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 7 } },
        },
      });

      const result = await getBucketObjectLock(s3, 'my-bucket');

      expect(result).toEqual({
        objectLockEnabled: true,
        defaultRetention: 'governance',
        retentionDuration: 7,
        retentionDurationType: 'd',
      });
    });

    it('parses an enabled config with a compliance years rule', async () => {
      s3Mock.on(GetObjectLockConfigurationCommand).resolves({
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Years: 1 } },
        },
      });

      const result = await getBucketObjectLock(s3, 'my-bucket');

      expect(result).toEqual({
        objectLockEnabled: true,
        defaultRetention: 'compliance',
        retentionDuration: 1,
        retentionDurationType: 'y',
      });
    });

    it('omits retention fields when no Rule is present', async () => {
      s3Mock.on(GetObjectLockConfigurationCommand).resolves({
        ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
      });

      const result = await getBucketObjectLock(s3, 'my-bucket');

      expect(result).toEqual({ objectLockEnabled: true });
    });

    it('returns null when object lock configuration is not found', async () => {
      s3Mock
        .on(GetObjectLockConfigurationCommand)
        .rejects(Object.assign(new Error('x'), { name: 'ObjectLockConfigurationNotFoundError' }));

      expect(await getBucketObjectLock(s3, 'my-bucket')).toBeNull();
    });

    it('rethrows unrelated errors', async () => {
      const sdkErr = Object.assign(new Error('denied'), { name: 'AccessDenied' });
      s3Mock.on(GetObjectLockConfigurationCommand).rejects(sdkErr);

      await expect(getBucketObjectLock(s3, 'my-bucket')).rejects.toBe(sdkErr);
    });
  });
});
