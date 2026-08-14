import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

import { BulkDeleteScope } from '@filone/shared';

import { deleteTargets, enumerateDeletionPage, type BulkDeleteTarget } from './s3-bulk-delete.js';
import { createS3Client } from './s3-client.js';

const s3Mock = mockClient(S3Client);

const s3 = createS3Client({
  endpointUrl: 'https://s3.example.com',
  region: 'auto',
  credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
  forcePathStyle: true,
  orchestratorId: 'test',
  tenantId: 'tenant-1',
});

const bucket = 'test-bucket';

beforeEach(() => {
  s3Mock.reset();
});

// ---------------------------------------------------------------------------
// enumerateDeletionPage
// ---------------------------------------------------------------------------

describe('enumerateDeletionPage — current scope', () => {
  it('lists current objects without version ids', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'a.txt' }, { Key: 'b.txt' }],
      IsTruncated: false,
    });

    const result = await enumerateDeletionPage({
      s3,
      bucket,
      prefix: '',
      scope: BulkDeleteScope.Current,
    });

    expect(result.targets).toEqual([{ key: 'a.txt' }, { key: 'b.txt' }]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('returns a continuation cursor while truncated', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'a.txt' }],
      IsTruncated: true,
      NextContinuationToken: 'token-2',
    });

    const result = await enumerateDeletionPage({
      s3,
      bucket,
      prefix: '',
      scope: BulkDeleteScope.Current,
    });

    expect(result.nextCursor).toEqual({ continuationToken: 'token-2' });
  });

  it('passes the prefix and resume token through', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });

    await enumerateDeletionPage({
      s3,
      bucket,
      prefix: 'photos/',
      scope: BulkDeleteScope.Current,
      cursor: { continuationToken: 'token-1' },
    });

    const input = s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input;
    expect(input.Prefix).toBe('photos/');
    expect(input.ContinuationToken).toBe('token-1');
  });
});

describe('enumerateDeletionPage — all versions scope', () => {
  it('includes delete markers alongside versions', async () => {
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [{ Key: 'a.txt', VersionId: 'v1' }],
      DeleteMarkers: [{ Key: 'a.txt', VersionId: 'dm1' }],
      IsTruncated: false,
    });

    const result = await enumerateDeletionPage({
      s3,
      bucket,
      prefix: '',
      scope: BulkDeleteScope.AllVersions,
    });

    expect(result.targets).toEqual([
      { key: 'a.txt', versionId: 'v1' },
      { key: 'a.txt', versionId: 'dm1' },
    ]);
  });

  it('drops the literal "null" version so non-versioned buckets get plain deletes', async () => {
    // A non-versioned or versioning-suspended bucket reports every object as the
    // "null" version. Carrying that id turns the delete into a version-scoped
    // one (s3:DeleteObjectVersion), which such buckets come back AccessDenied on.
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [{ Key: 'a.txt', VersionId: 'null' }],
      IsTruncated: false,
    });

    const result = await enumerateDeletionPage({
      s3,
      bucket,
      prefix: '',
      scope: BulkDeleteScope.AllVersions,
    });

    expect(result.targets).toEqual([{ key: 'a.txt' }]);
  });

  it('returns the key and version-id marker pair while truncated', async () => {
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [{ Key: 'a.txt', VersionId: 'v1' }],
      IsTruncated: true,
      NextKeyMarker: 'a.txt',
      NextVersionIdMarker: 'v1',
    });

    const result = await enumerateDeletionPage({
      s3,
      bucket,
      prefix: '',
      scope: BulkDeleteScope.AllVersions,
    });

    expect(result.nextCursor).toEqual({ keyMarker: 'a.txt', versionIdMarker: 'v1' });
  });

  it('treats a page with no markers as the end of the walk', async () => {
    s3Mock.on(ListObjectVersionsCommand).resolves({ Versions: [], IsTruncated: false });

    const result = await enumerateDeletionPage({
      s3,
      bucket,
      prefix: '',
      scope: BulkDeleteScope.AllVersions,
    });

    expect(result.targets).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deleteTargets
// ---------------------------------------------------------------------------

describe('deleteTargets', () => {
  it('does nothing for an empty target list', async () => {
    const result = await deleteTargets({ s3, bucket, targets: [] });
    expect(result).toEqual({ deleted: 0, failures: [] });
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });

  it('counts every key in a quiet batch as deleted', async () => {
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const result = await deleteTargets({
      s3,
      bucket,
      targets: [{ key: 'a.txt' }, { key: 'b.txt' }],
    });

    expect(result.deleted).toBe(2);
    expect(result.failures).toEqual([]);
  });

  it('splits into batches of 1000', async () => {
    s3Mock.on(DeleteObjectsCommand).resolves({});
    const targets: BulkDeleteTarget[] = Array.from({ length: 2500 }, (_, i) => ({
      key: `obj-${i}`,
    }));

    const result = await deleteTargets({ s3, bucket, targets });

    const calls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(calls).toHaveLength(3);
    expect(calls[0].args[0].input.Delete?.Objects).toHaveLength(1000);
    expect(calls[2].args[0].input.Delete?.Objects).toHaveLength(500);
    expect(result.deleted).toBe(2500);
  });

  it('forwards version ids', async () => {
    s3Mock.on(DeleteObjectsCommand).resolves({});

    await deleteTargets({ s3, bucket, targets: [{ key: 'a.txt', versionId: 'v1' }] });

    expect(s3Mock.commandCalls(DeleteObjectsCommand)[0].args[0].input.Delete?.Objects).toEqual([
      { Key: 'a.txt', VersionId: 'v1' },
    ]);
  });

  it('reports per-key errors without failing the batch', async () => {
    s3Mock.on(DeleteObjectsCommand).resolves({
      Errors: [{ Key: 'locked.txt', Code: 'AccessDenied', Message: 'Object is under retention' }],
    });

    const result = await deleteTargets({
      s3,
      bucket,
      targets: [{ key: 'a.txt' }, { key: 'locked.txt' }],
    });

    expect(result.deleted).toBe(1);
    expect(result.failures).toEqual([
      { key: 'locked.txt', code: 'AccessDenied', message: 'Object is under retention' },
    ]);
  });

  it('propagates a batch-level failure rather than swallowing it', async () => {
    // A whole-request rejection (not per-key errors) means the page did not
    // complete; it must surface so the worker records the job as failed rather
    // than counting the page as deleted.
    s3Mock.on(DeleteObjectsCommand).rejects(
      Object.assign(new Error('boom'), {
        name: 'InternalError',
        $metadata: { httpStatusCode: 500 },
      }),
    );

    await expect(deleteTargets({ s3, bucket, targets: [{ key: 'a.txt' }] })).rejects.toThrow(
      'boom',
    );
  });
});
