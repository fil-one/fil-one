import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

import { BulkDeleteScope } from '@filone/shared';

import {
  deleteTargets,
  enumerateDeletionPage,
  isUnsupportedOperationError,
  type BulkDeleteTarget,
} from './s3-bulk-delete.js';
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

function unsupported(status: number) {
  return Object.assign(new Error('not implemented'), {
    name: 'NotImplemented',
    $metadata: { httpStatusCode: status },
  });
}

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

describe('deleteTargets — batched path', () => {
  it('does nothing for an empty target list', async () => {
    const result = await deleteTargets({ s3, bucket, targets: [] });
    expect(result).toEqual({ deleted: 0, failures: [], multiDeleteUnsupported: false });
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
});

describe('deleteTargets — per-object fallback', () => {
  it('uses individual deletes when multiDelete is off', async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});

    const result = await deleteTargets({
      s3,
      bucket,
      targets: [{ key: 'a.txt' }, { key: 'b.txt' }],
      multiDelete: false,
    });

    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(2);
    expect(result.deleted).toBe(2);
    expect(result.multiDeleteUnsupported).toBe(false);
  });

  it('falls back and flags the gateway when DeleteObjects is not implemented', async () => {
    s3Mock.on(DeleteObjectsCommand).rejects(unsupported(501));
    s3Mock.on(DeleteObjectCommand).resolves({});

    const result = await deleteTargets({
      s3,
      bucket,
      targets: [{ key: 'a.txt' }, { key: 'b.txt' }],
    });

    expect(result.deleted).toBe(2);
    expect(result.multiDeleteUnsupported).toBe(true);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(2);
  });

  it('propagates a genuine batch failure instead of silently retrying', async () => {
    s3Mock.on(DeleteObjectsCommand).rejects(
      Object.assign(new Error('boom'), {
        name: 'InternalError',
        $metadata: { httpStatusCode: 500 },
      }),
    );

    await expect(deleteTargets({ s3, bucket, targets: [{ key: 'a.txt' }] })).rejects.toThrow(
      'boom',
    );
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it('records a failure per rejected object and keeps going', async () => {
    s3Mock.on(DeleteObjectCommand).rejects(new Error('denied'));

    const result = await deleteTargets({
      s3,
      bucket,
      targets: [{ key: 'a.txt' }, { key: 'b.txt' }],
      multiDelete: false,
    });

    expect(result.deleted).toBe(0);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].message).toBe('denied');
  });

  it('deletes every target even when more targets than the concurrency limit', async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    const targets = Array.from({ length: 100 }, (_, i) => ({ key: `obj-${i}` }));

    const result = await deleteTargets({
      s3,
      bucket,
      targets,
      multiDelete: false,
      concurrency: 4,
    });

    expect(result.deleted).toBe(100);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(100);
  });
});

describe('isUnsupportedOperationError', () => {
  it('recognizes 501 and 405 responses', () => {
    expect(isUnsupportedOperationError(unsupported(501))).toBe(true);
    expect(isUnsupportedOperationError(unsupported(405))).toBe(true);
  });

  it('recognizes the error codes gateways use', () => {
    expect(isUnsupportedOperationError({ Code: 'NotImplemented' })).toBe(true);
    expect(isUnsupportedOperationError({ name: 'MethodNotAllowed' })).toBe(true);
  });

  it('rejects ordinary failures and non-objects', () => {
    expect(isUnsupportedOperationError(new Error('boom'))).toBe(false);
    expect(isUnsupportedOperationError(null)).toBe(false);
    expect(isUnsupportedOperationError('nope')).toBe(false);
  });
});
