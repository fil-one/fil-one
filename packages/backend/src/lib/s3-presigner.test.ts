import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetSignedUrl = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

import {
  getPresignedDeleteObjectUrl,
  getPresignedGetObjectRetentionUrl,
  getPresignedGetObjectUrl,
  getPresignedHeadObjectUrl,
  getPresignedListObjectVersionsUrl,
  getPresignedListObjectsUrl,
  getPresignedPutObjectUrl,
} from './s3-presigner.js';
import type { S3ClientContext } from './s3-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ctx: S3ClientContext = {
  endpointUrl: 'https://s3.example.com',
  region: 'auto',
  credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
  forcePathStyle: true,
  orchestratorId: 'test',
  tenantId: 't-1',
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
