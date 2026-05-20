import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
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
  getPresignedDeleteObjectUrl,
  getPresignedGetObjectRetentionUrl,
  getPresignedGetObjectUrl,
  getPresignedHeadObjectUrl,
  getPresignedListObjectVersionsUrl,
  getPresignedListObjectsUrl,
  getPresignedPutObjectUrl,
  listBuckets,
  listObjects,
} from './s3-presigner.js';
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
