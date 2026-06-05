import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutObjectLockConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetSignedUrl = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

const s3Mock = mockClient(S3Client);

import {
  createBucket,
  getBucketObjectLock,
  getBucketVersioning,
  getPresignedDeleteObjectUrl,
  getPresignedGetObjectRetentionUrl,
  getPresignedGetObjectUrl,
  getPresignedHeadObjectUrl,
  getPresignedListObjectVersionsUrl,
  getPresignedListObjectsUrl,
  getPresignedPutObjectUrl,
  listBuckets,
  listObjects,
  putObjectLockConfiguration,
  setBucketVersioning,
} from './s3-presigner.js';
import { BucketAlreadyExistsError } from './errors.js';
import type { PresignerContext } from './service-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ctx: PresignerContext = {
  endpointUrl: 'https://s3.example.com',
  region: 'auto',
  credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
  forcePathStyle: true,
};

// Capture the last command passed to getSignedUrl, so each test can assert
// on its constructor and `input` shape without coupling to the command
// instance built inside the helper.
function lastSignedCommand() {
  expect(mockGetSignedUrl).toHaveBeenCalled();
  const calls = mockGetSignedUrl.mock.calls;
  return calls[calls.length - 1][1] as { constructor: { name: string }; input: unknown };
}

function lastSignedOptions() {
  const calls = mockGetSignedUrl.mock.calls;
  return calls[calls.length - 1][2] as { expiresIn: number };
}

// ---------------------------------------------------------------------------
// Direct operations
// ---------------------------------------------------------------------------

describe('s3-presigner direct operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3Mock.reset();
  });

  describe('createBucket', () => {
    it('sends a CreateBucketCommand with the supplied bucket name', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});

      await createBucket(ctx, { bucketName: 'my-bucket' });

      const calls = s3Mock.commandCalls(CreateBucketCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({ Bucket: 'my-bucket' });
    });

    it('sends ObjectLockEnabledForBucket:true when objectLockEnabled is set', async () => {
      s3Mock.on(CreateBucketCommand).resolves({});

      await createBucket(ctx, { bucketName: 'my-bucket', objectLockEnabled: true });

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

        await expect(createBucket(ctx, { bucketName: 'my-bucket' })).rejects.toBeInstanceOf(
          BucketAlreadyExistsError,
        );
      });
    }

    it('attaches the original SDK error as the cause of BucketAlreadyExistsError', async () => {
      const sdkErr = Object.assign(new Error('already there'), { name: 'BucketAlreadyExists' });
      s3Mock.on(CreateBucketCommand).rejects(sdkErr);

      await expect(createBucket(ctx, { bucketName: 'my-bucket' })).rejects.toMatchObject({
        cause: sdkErr,
      });
    });

    it('propagates unrelated SDK errors unchanged', async () => {
      const sdkErr = Object.assign(new Error('denied'), { name: 'AccessDenied' });
      s3Mock.on(CreateBucketCommand).rejects(sdkErr);

      await expect(createBucket(ctx, { bucketName: 'my-bucket' })).rejects.toBe(sdkErr);
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

      const result = await listBuckets(ctx);

      expect(result.buckets).toEqual([
        { name: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
        { name: 'b', createdAt: '2026-01-01T00:00:00.000Z' },
      ]);
    });

    it('falls back to a current timestamp when CreationDate is missing', async () => {
      s3Mock.on(ListBucketsCommand).resolves({ Buckets: [{ Name: 'a' }] });

      const result = await listBuckets(ctx);

      expect(result.buckets[0]?.name).toBe('a');
      expect(typeof result.buckets[0]?.createdAt).toBe('string');
      expect(Number.isNaN(Date.parse(result.buckets[0]!.createdAt))).toBe(false);
    });

    it('returns an empty array when no buckets exist', async () => {
      s3Mock.on(ListBucketsCommand).resolves({});

      const result = await listBuckets(ctx);

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

      const result = await listObjects({ ctx, bucket: 'my-bucket' });

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
        ctx,
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

      const result = await listObjects({ ctx, bucket: 'my-bucket' });

      expect(result.nextToken).toBe('page-2');
      expect(result.isTruncated).toBe(true);
    });

    it('handles entries with missing optional fields', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: 'a.txt' }],
      });

      const result = await listObjects({ ctx, bucket: 'my-bucket' });

      expect(result.objects[0]).toMatchObject({ key: 'a.txt', sizeBytes: 0 });
      expect(typeof result.objects[0]?.lastModified).toBe('string');
      expect(result.objects[0]?.etag).toBeUndefined();
    });
  });

  describe('setBucketVersioning', () => {
    it('sends Status Enabled when enabled defaults to true', async () => {
      s3Mock.on(PutBucketVersioningCommand).resolves({});

      await setBucketVersioning(ctx, 'my-bucket');

      const calls = s3Mock.commandCalls(PutBucketVersioningCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({
        Bucket: 'my-bucket',
        VersioningConfiguration: { Status: 'Enabled' },
      });
    });

    it('sends Status Suspended when enabled is false', async () => {
      s3Mock.on(PutBucketVersioningCommand).resolves({});

      await setBucketVersioning(ctx, 'my-bucket', false);

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

      await putObjectLockConfiguration(ctx, {
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

      await putObjectLockConfiguration(ctx, {
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

      expect(await getBucketVersioning(ctx, 'my-bucket')).toBe(true);
    });

    it('returns false when Status is Suspended', async () => {
      s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Suspended' });

      expect(await getBucketVersioning(ctx, 'my-bucket')).toBe(false);
    });

    it('returns false when Status is undefined', async () => {
      s3Mock.on(GetBucketVersioningCommand).resolves({});

      expect(await getBucketVersioning(ctx, 'my-bucket')).toBe(false);
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

      const result = await getBucketObjectLock(ctx, 'my-bucket');

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

      const result = await getBucketObjectLock(ctx, 'my-bucket');

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

      const result = await getBucketObjectLock(ctx, 'my-bucket');

      expect(result).toEqual({ objectLockEnabled: true });
    });

    it('returns null when object lock configuration is not found', async () => {
      s3Mock
        .on(GetObjectLockConfigurationCommand)
        .rejects(Object.assign(new Error('x'), { name: 'ObjectLockConfigurationNotFoundError' }));

      expect(await getBucketObjectLock(ctx, 'my-bucket')).toBeNull();
    });

    it('rethrows unrelated errors', async () => {
      const sdkErr = Object.assign(new Error('denied'), { name: 'AccessDenied' });
      s3Mock.on(GetObjectLockConfigurationCommand).rejects(sdkErr);

      await expect(getBucketObjectLock(ctx, 'my-bucket')).rejects.toBe(sdkErr);
    });
  });
});

// ---------------------------------------------------------------------------
// Presigned URL helpers
// ---------------------------------------------------------------------------

describe('s3-presigner presigned URL helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSignedUrl.mockResolvedValue('https://signed.example.com/url');
  });

  describe('getPresignedPutObjectUrl', () => {
    it('signs a PutObjectCommand with content type and metadata', async () => {
      const url = await getPresignedPutObjectUrl({
        ctx,
        bucket: 'b',
        key: 'k',
        expiresIn: 300,
        contentType: 'text/plain',
        metadata: { filename: 'k.txt' },
      });

      expect(url).toBe('https://signed.example.com/url');
      const cmd = lastSignedCommand();
      expect(cmd.constructor.name).toBe(PutObjectCommand.name);
      expect(cmd.input).toEqual({
        Bucket: 'b',
        Key: 'k',
        ContentType: 'text/plain',
        Metadata: { filename: 'k.txt' },
      });
      expect(lastSignedOptions()).toEqual({ expiresIn: 300 });
    });

    it('omits ContentType and Metadata when not provided', async () => {
      await getPresignedPutObjectUrl({ ctx, bucket: 'b', key: 'k', expiresIn: 300 });

      const cmd = lastSignedCommand();
      expect(cmd.input).toEqual({ Bucket: 'b', Key: 'k' });
    });
  });

  describe('getPresignedGetObjectUrl', () => {
    it('signs a GetObjectCommand and forwards versionId', async () => {
      await getPresignedGetObjectUrl({
        ctx,
        bucket: 'b',
        key: 'k',
        expiresIn: 300,
        versionId: 'v1',
      });

      const cmd = lastSignedCommand();
      expect(cmd.constructor.name).toBe(GetObjectCommand.name);
      expect(cmd.input).toEqual({ Bucket: 'b', Key: 'k', VersionId: 'v1' });
    });
  });

  describe('getPresignedListObjectsUrl', () => {
    it('signs a ListObjectsV2Command including optional pagination params', async () => {
      await getPresignedListObjectsUrl({
        ctx,
        bucket: 'b',
        expiresIn: 300,
        prefix: 'p/',
        delimiter: '/',
        maxKeys: 10,
        continuationToken: 't',
      });

      const cmd = lastSignedCommand();
      expect(cmd.constructor.name).toBe(ListObjectsV2Command.name);
      expect(cmd.input).toEqual({
        Bucket: 'b',
        Prefix: 'p/',
        Delimiter: '/',
        MaxKeys: 10,
        ContinuationToken: 't',
      });
    });
  });

  describe('getPresignedListObjectVersionsUrl', () => {
    it('signs a ListObjectVersionsCommand including markers', async () => {
      await getPresignedListObjectVersionsUrl({
        ctx,
        bucket: 'b',
        expiresIn: 300,
        keyMarker: 'k1',
        versionIdMarker: 'v1',
      });

      const cmd = lastSignedCommand();
      expect(cmd.constructor.name).toBe(ListObjectVersionsCommand.name);
      expect(cmd.input).toMatchObject({
        Bucket: 'b',
        KeyMarker: 'k1',
        VersionIdMarker: 'v1',
      });
    });
  });

  describe('getPresignedHeadObjectUrl', () => {
    it('signs a HeadObjectCommand', async () => {
      await getPresignedHeadObjectUrl({ ctx, bucket: 'b', key: 'k', expiresIn: 300 });

      const cmd = lastSignedCommand();
      expect(cmd.constructor.name).toBe(HeadObjectCommand.name);
      expect(cmd.input).toEqual({ Bucket: 'b', Key: 'k' });
    });
  });

  describe('getPresignedGetObjectRetentionUrl', () => {
    it('signs a GetObjectRetentionCommand', async () => {
      await getPresignedGetObjectRetentionUrl({
        ctx,
        bucket: 'b',
        key: 'k',
        expiresIn: 300,
        versionId: 'v1',
      });

      const cmd = lastSignedCommand();
      expect(cmd.constructor.name).toBe(GetObjectRetentionCommand.name);
      expect(cmd.input).toEqual({ Bucket: 'b', Key: 'k', VersionId: 'v1' });
    });
  });

  describe('getPresignedDeleteObjectUrl', () => {
    it('signs a DeleteObjectCommand', async () => {
      await getPresignedDeleteObjectUrl({ ctx, bucket: 'b', key: 'k', expiresIn: 300 });

      const cmd = lastSignedCommand();
      expect(cmd.constructor.name).toBe(DeleteObjectCommand.name);
      expect(cmd.input).toEqual({ Bucket: 'b', Key: 'k' });
    });
  });
});
