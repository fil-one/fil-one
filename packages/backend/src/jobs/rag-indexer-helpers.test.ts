import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import type { VectorStore } from '@filone/rag-shared';
import type { ListObjectsResult } from '../lib/s3-bucket-operations.js';
import type { ManifestEntry } from './rag-indexer-manifest.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockListObjects,
  mockGetObjectBytes,
  mockExtractText,
  mockChunk,
  mockEmbedMany,
  mockLoadManifest,
  mockSaveManifestEntry,
  mockDeleteManifestEntry,
  mockLoadCheckpoint,
  mockSaveCheckpoint,
  mockClearCheckpoint,
  mockUpdateBucketTelemetry,
} = vi.hoisted(() => ({
  mockListObjects: vi.fn(),
  mockGetObjectBytes: vi.fn(),
  mockExtractText: vi.fn(),
  mockChunk: vi.fn(),
  mockEmbedMany: vi.fn(),
  mockLoadManifest: vi.fn(),
  mockSaveManifestEntry: vi.fn(),
  mockDeleteManifestEntry: vi.fn(),
  mockLoadCheckpoint: vi.fn(),
  mockSaveCheckpoint: vi.fn(),
  mockClearCheckpoint: vi.fn(),
  mockUpdateBucketTelemetry: vi.fn(),
}));

vi.mock('../lib/s3-bucket-operations.js', () => ({
  listObjects: mockListObjects,
  getObjectBytes: mockGetObjectBytes,
}));

vi.mock('../lib/bucket-rag-enablement.js', () => ({
  updateBucketTelemetry: mockUpdateBucketTelemetry,
}));

vi.mock('@filone/rag-shared', () => ({
  extractText: mockExtractText,
  chunk: mockChunk,
  embedMany: mockEmbedMany,
}));

vi.mock('./rag-indexer-manifest.js', () => ({
  loadManifest: mockLoadManifest,
  saveManifestEntry: mockSaveManifestEntry,
  deleteManifestEntry: mockDeleteManifestEntry,
  loadCheckpoint: mockLoadCheckpoint,
  saveCheckpoint: mockSaveCheckpoint,
  clearCheckpoint: mockClearCheckpoint,
}));

import { indexBucket } from './rag-indexer-helpers.js';
import { S3Region } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const s3 = {} as S3Client;

function makeVectorStore() {
  return {
    ensureIndex: vi.fn().mockResolvedValue(undefined),
    upsertChunks: vi.fn().mockResolvedValue(undefined),
    deleteChunks: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(),
    dropIndex: vi.fn(),
  } satisfies VectorStore;
}

function page(
  objects: Array<{ key: string; etag?: string; sizeBytes?: number }>,
  next?: string,
): ListObjectsResult {
  return {
    objects: objects.map((o) => ({
      key: o.key,
      sizeBytes: o.sizeBytes ?? 1,
      lastModified: '2024-01-01T00:00:00.000Z',
      ...(o.etag ? { etag: o.etag } : {}),
    })),
    ...(next ? { nextToken: next } : {}),
    isTruncated: next !== undefined,
  };
}

function manifestOf(entries: ManifestEntry[]): Map<string, ManifestEntry> {
  return new Map(entries.map((e) => [e.objectKey, e]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('indexBucket', () => {
  let vectorStore: ReturnType<typeof makeVectorStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vectorStore = makeVectorStore();
    mockLoadCheckpoint.mockResolvedValue(undefined);
    mockSaveCheckpoint.mockResolvedValue(undefined);
    mockClearCheckpoint.mockResolvedValue(undefined);
    mockSaveManifestEntry.mockResolvedValue(undefined);
    mockDeleteManifestEntry.mockResolvedValue(undefined);
    mockGetObjectBytes.mockResolvedValue({ bytes: new Uint8Array([1]), contentType: 'text/plain' });
    mockExtractText.mockResolvedValue('hello world');
    mockChunk.mockReturnValue(['hello world']);
    mockEmbedMany.mockResolvedValue([[0.1, 0.2, 0.3]]);
    mockUpdateBucketTelemetry.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ensures the index before reconciling', async () => {
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects.mockResolvedValue(page([]));

    await indexBucket({ s3, region: S3Region.EuWest1, bucketName: 'bucket-1', vectorStore });

    expect(vectorStore.ensureIndex).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1');
  });

  it('enumerates objects via listObjects with no HeadObject calls', async () => {
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects.mockResolvedValue(page([{ key: 'a.txt', etag: 'e1' }]));

    await indexBucket({ s3, region: S3Region.EuWest1, bucketName: 'bucket-1', vectorStore });

    expect(mockListObjects).toHaveBeenCalledWith({
      s3,
      bucket: 'bucket-1',
      continuationToken: undefined,
    });
    // The only S3 reads are listObjects + the per-object getObjectBytes — no HeadObject path exists.
    expect(mockGetObjectBytes).toHaveBeenCalledTimes(1);
  });

  it('indexes a new object: extract + chunk + embed + upsert + manifest', async () => {
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects.mockResolvedValue(page([{ key: 'a.txt', etag: 'e1' }]));
    mockChunk.mockReturnValue(['c0', 'c1']);
    mockEmbedMany.mockResolvedValue([[0.1], [0.2]]);

    const result = await indexBucket({
      s3,
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      vectorStore,
    });

    expect(mockExtractText).toHaveBeenCalledOnce();
    expect(mockEmbedMany).toHaveBeenCalledWith(['c0', 'c1']);
    expect(vectorStore.upsertChunks).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1', [
      { key: 'a.txt#0', text: 'c0', metadata: { objectKey: 'a.txt' }, embedding: [0.1] },
      { key: 'a.txt#1', text: 'c1', metadata: { objectKey: 'a.txt' }, embedding: [0.2] },
    ]);
    expect(mockSaveManifestEntry).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1', {
      objectKey: 'a.txt',
      etag: 'e1',
      chunkKeys: ['a.txt#0', 'a.txt#1'],
    });
    expect(result).toMatchObject({ added: 1, updated: 0, removed: 0, failed: 0, completed: true });
  });

  // -----------------------------------------------------------------------
  // PDF objects: extraction is routed through Textract, which reads the object
  // straight from S3, so the object's own location is handed in as `documentLocation`.
  // -----------------------------------------------------------------------

  it('indexes a PDF object, handing Textract the object S3 location as documentLocation', async () => {
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects.mockResolvedValue(page([{ key: 'doc.pdf', etag: 'e1' }]));
    const bytes = new Uint8Array([1, 2, 3]);
    mockGetObjectBytes.mockResolvedValue({ bytes, contentType: 'application/pdf' });
    mockExtractText.mockResolvedValue('pdf text');

    const result = await indexBucket({
      s3,
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      vectorStore,
    });

    expect(mockExtractText).toHaveBeenCalledWith(bytes, 'application/pdf', {
      pdf: { documentLocation: { Bucket: 'bucket-1', Name: 'doc.pdf' } },
    });
    expect(vectorStore.upsertChunks).toHaveBeenCalledOnce();
    expect(mockSaveManifestEntry).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1', {
      objectKey: 'doc.pdf',
      etag: 'e1',
      chunkKeys: ['doc.pdf#0'],
    });
    expect(result).toMatchObject({ added: 1, failed: 0, completed: true });
  });

  it('treats a PDF resolved by file extension (generic stored type) as a PDF', async () => {
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects.mockResolvedValue(page([{ key: 'report.pdf', etag: 'e1' }]));
    const bytes = new Uint8Array([9]);
    // Stored content type carries no signal; the .pdf extension drives the type.
    mockGetObjectBytes.mockResolvedValue({ bytes, contentType: 'application/octet-stream' });

    await indexBucket({ s3, region: S3Region.EuWest1, bucketName: 'bucket-1', vectorStore });

    expect(mockExtractText).toHaveBeenCalledWith(bytes, 'application/pdf', {
      pdf: { documentLocation: { Bucket: 'bucket-1', Name: 'report.pdf' } },
    });
  });

  it('forwards no PDF options for a non-PDF object', async () => {
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects.mockResolvedValue(page([{ key: 'a.txt', etag: 'e1' }]));

    await indexBucket({ s3, region: S3Region.EuWest1, bucketName: 'bucket-1', vectorStore });

    expect(mockExtractText).toHaveBeenCalledWith(new Uint8Array([1]), 'text/plain', {});
  });

  it('counts a PDF as failed (isolated) when Textract extraction throws', async () => {
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects.mockResolvedValue(page([{ key: 'doc.pdf', etag: 'e1' }]));
    mockGetObjectBytes.mockResolvedValue({
      bytes: new Uint8Array([1]),
      contentType: 'application/pdf',
    });
    mockExtractText.mockRejectedValue(new Error('Textract job failed'));

    const result = await indexBucket({
      s3,
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      vectorStore,
    });

    expect(vectorStore.upsertChunks).not.toHaveBeenCalled();
    expect(mockSaveManifestEntry).not.toHaveBeenCalled();
    expect(result).toMatchObject({ added: 0, failed: 1, completed: true });
  });

  it('re-indexes a changed object: deletes old chunks then re-upserts + updates manifest', async () => {
    mockLoadManifest.mockResolvedValue(
      manifestOf([
        { objectKey: 'a.txt', etag: 'old', chunkKeys: ['a.txt#0'], updatedAt: '2024-01-01' },
      ]),
    );
    mockListObjects.mockResolvedValue(page([{ key: 'a.txt', etag: 'new' }]));
    mockChunk.mockReturnValue(['c0']);
    mockEmbedMany.mockResolvedValue([[0.9]]);

    const result = await indexBucket({
      s3,
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      vectorStore,
    });

    expect(vectorStore.deleteChunks).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1', [
      'a.txt#0',
    ]);
    expect(vectorStore.upsertChunks).toHaveBeenCalledOnce();
    expect(mockSaveManifestEntry).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1', {
      objectKey: 'a.txt',
      etag: 'new',
      chunkKeys: ['a.txt#0'],
    });
    expect(result).toMatchObject({ added: 0, updated: 1, removed: 0 });
  });

  it('skips an unchanged object: zero embed/upsert on a same-ETag re-run', async () => {
    mockLoadManifest.mockResolvedValue(
      manifestOf([
        { objectKey: 'a.txt', etag: 'same', chunkKeys: ['a.txt#0'], updatedAt: '2024-01-01' },
      ]),
    );
    mockListObjects.mockResolvedValue(page([{ key: 'a.txt', etag: 'same' }]));

    const result = await indexBucket({
      s3,
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      vectorStore,
    });

    expect(mockGetObjectBytes).not.toHaveBeenCalled();
    expect(mockExtractText).not.toHaveBeenCalled();
    expect(mockEmbedMany).not.toHaveBeenCalled();
    expect(vectorStore.upsertChunks).not.toHaveBeenCalled();
    expect(result).toMatchObject({ added: 0, updated: 0, removed: 0, failed: 0 });
  });

  it('removes an object absent from S3: deletes chunks + removes manifest entry', async () => {
    mockLoadManifest.mockResolvedValue(
      manifestOf([
        {
          objectKey: 'gone.txt',
          etag: 'e',
          chunkKeys: ['gone.txt#0', 'gone.txt#1'],
          updatedAt: 'x',
        },
      ]),
    );
    mockListObjects.mockResolvedValue(page([]));

    const result = await indexBucket({
      s3,
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      vectorStore,
    });

    expect(vectorStore.deleteChunks).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1', [
      'gone.txt#0',
      'gone.txt#1',
    ]);
    expect(mockDeleteManifestEntry).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1', 'gone.txt');
    expect(result).toMatchObject({ added: 0, updated: 0, removed: 1 });
  });

  it('isolates a per-object failure: one bad object does not abort the rest', async () => {
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects.mockResolvedValue(
      page([
        { key: 'bad.txt', etag: 'e1' },
        { key: 'good.txt', etag: 'e2' },
      ]),
    );
    mockGetObjectBytes
      .mockRejectedValueOnce(new Error('S3 read failed'))
      .mockResolvedValue({ bytes: new Uint8Array([1]), contentType: 'text/plain' });

    const result = await indexBucket({
      s3,
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      vectorStore,
    });

    expect(result).toMatchObject({ added: 1, failed: 1, completed: true });
    expect(mockSaveManifestEntry).toHaveBeenCalledOnce();
    expect(mockSaveManifestEntry).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1', {
      objectKey: 'good.txt',
      etag: 'e2',
      chunkKeys: ['good.txt#0'],
    });
  });

  it('skips objects with no usable content type without failing the run', async () => {
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects.mockResolvedValue(page([{ key: 'photo.png', etag: 'e1' }]));
    mockGetObjectBytes.mockResolvedValue({ bytes: new Uint8Array([1]), contentType: undefined });

    const result = await indexBucket({
      s3,
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      vectorStore,
    });

    expect(mockExtractText).not.toHaveBeenCalled();
    expect(vectorStore.upsertChunks).not.toHaveBeenCalled();
    expect(result).toMatchObject({ added: 0, failed: 0, completed: true });
  });

  it('skips objects with no ETag in the listing', async () => {
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects.mockResolvedValue(page([{ key: 'a.txt' }]));

    const result = await indexBucket({
      s3,
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      vectorStore,
    });

    expect(mockGetObjectBytes).not.toHaveBeenCalled();
    expect(result).toMatchObject({ added: 0, failed: 0 });
  });

  // -----------------------------------------------------------------------
  // Pagination + checkpoint/resume
  // -----------------------------------------------------------------------

  it('pages through the full listing, threading the continuation token', async () => {
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects
      .mockResolvedValueOnce(page([{ key: 'a.txt', etag: 'e1' }], 'tok-1'))
      .mockResolvedValueOnce(page([{ key: 'b.txt', etag: 'e2' }]));

    const result = await indexBucket({
      s3,
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      vectorStore,
    });

    expect(mockListObjects).toHaveBeenNthCalledWith(1, {
      s3,
      bucket: 'bucket-1',
      continuationToken: undefined,
    });
    expect(mockListObjects).toHaveBeenNthCalledWith(2, {
      s3,
      bucket: 'bucket-1',
      continuationToken: 'tok-1',
    });
    // A checkpoint is persisted after each non-final page.
    expect(mockSaveCheckpoint).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1', 'tok-1');
    expect(result).toMatchObject({ added: 2, completed: true });
  });

  it('clears the checkpoint once a bucket is fully reconciled', async () => {
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects.mockResolvedValue(page([{ key: 'a.txt', etag: 'e1' }]));

    await indexBucket({ s3, region: S3Region.EuWest1, bucketName: 'bucket-1', vectorStore });

    expect(mockClearCheckpoint).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1');
  });

  it('resumes from a persisted continuation token', async () => {
    mockLoadCheckpoint.mockResolvedValue({
      pk: 'INDEXER_CHECKPOINT#bucket-1',
      sk: 'CHECKPOINT',
      bucketId: 'bucket-1',

      continuationToken: 'resume-tok',
      lastPageStartedAt: '2024-01-01T00:00:00.000Z',
      ttl: Math.floor(Date.now() / 1000) + 3600,
    });
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects.mockResolvedValue(page([{ key: 'a.txt', etag: 'e1' }]));

    await indexBucket({ s3, region: S3Region.EuWest1, bucketName: 'bucket-1', vectorStore });

    expect(mockListObjects).toHaveBeenCalledWith({
      s3,
      bucket: 'bucket-1',
      continuationToken: 'resume-tok',
    });
  });

  it('does NOT delete earlier-page objects when a resumed run only sees later pages (data-loss regression)', async () => {
    // The earlier (checkpointed) run indexed page 1's object `a.txt`; it is
    // already in the manifest and still exists in S3. This run RESUMES from a
    // continuation token and only lists page 2 (`b.txt`), so `seen` never holds
    // `a.txt`. The old code treated `a.txt` as removed and deleted it; the fix
    // skips removal reconciliation entirely on a resumed (partial) pass.
    mockLoadCheckpoint.mockResolvedValue({
      pk: 'INDEXER_CHECKPOINT#bucket-1',
      sk: 'CHECKPOINT',
      bucketId: 'bucket-1',

      continuationToken: 'page-2-tok',
      lastPageStartedAt: '2024-01-01T00:00:00.000Z',
      ttl: Math.floor(Date.now() / 1000) + 3600,
    });
    mockLoadManifest.mockResolvedValue(
      manifestOf([
        { objectKey: 'a.txt', etag: 'e1', chunkKeys: ['a.txt#0'], updatedAt: '2024-01-01' },
      ]),
    );
    // The resumed invocation only lists the final page (page 2).
    mockListObjects.mockResolvedValue(page([{ key: 'b.txt', etag: 'e2' }]));

    const result = await indexBucket({
      s3,
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      vectorStore,
    });

    // a.txt still exists in S3 — it must NOT be removed from the index.
    expect(vectorStore.deleteChunks).not.toHaveBeenCalled();
    expect(mockDeleteManifestEntry).not.toHaveBeenCalled();
    expect(result.removed).toBe(0);
    // The new object on this page is still indexed normally.
    expect(result).toMatchObject({ added: 1, completed: true });
    expect(mockClearCheckpoint).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1');
  });

  it('reconciles removals on a fresh (non-resumed) full pass', async () => {
    // Sanity counterpart to the regression above: when this invocation walks the
    // bucket from the first page (no checkpoint) and the manifest holds an object
    // that is no longer listed, it IS treated as removed.
    mockLoadCheckpoint.mockResolvedValue(undefined);
    mockLoadManifest.mockResolvedValue(
      manifestOf([{ objectKey: 'gone.txt', etag: 'e', chunkKeys: ['gone.txt#0'], updatedAt: 'x' }]),
    );
    mockListObjects.mockResolvedValue(page([{ key: 'a.txt', etag: 'e1' }]));

    const result = await indexBucket({
      s3,
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      vectorStore,
    });

    expect(vectorStore.deleteChunks).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1', [
      'gone.txt#0',
    ]);
    expect(mockDeleteManifestEntry).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1', 'gone.txt');
    expect(result).toMatchObject({ added: 1, removed: 1, completed: true });
  });

  it('checkpoints and stops when the deadline passes mid-bucket', async () => {
    mockLoadManifest.mockResolvedValue(manifestOf([]));
    mockListObjects.mockResolvedValue(page([{ key: 'a.txt', etag: 'e1' }], 'next-tok'));

    // Deadline already passed: indexBucket must checkpoint without listing.
    const result = await indexBucket(
      { s3, region: S3Region.EuWest1, bucketName: 'bucket-1', vectorStore },
      { deadlineEpochMs: Date.now() - 1 },
    );

    expect(mockListObjects).not.toHaveBeenCalled();
    expect(mockSaveCheckpoint).toHaveBeenCalledWith(S3Region.EuWest1, 'bucket-1', undefined);
    expect(mockClearCheckpoint).not.toHaveBeenCalled();
    expect(result.completed).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Sync telemetry (FIL-556)
  // -----------------------------------------------------------------------

  describe('sync telemetry', () => {
    /** The telemetry update issued for a given syncState, or undefined. */
    function telemetryCall(syncState: string) {
      return mockUpdateBucketTelemetry.mock.calls.find(
        (c) => (c[2] as { syncState: string }).syncState === syncState,
      );
    }

    it('marks the bucket syncing at the very start of the run (syncState only)', async () => {
      mockLoadManifest.mockResolvedValue(manifestOf([]));
      mockListObjects.mockResolvedValue(page([]));

      await indexBucket({ s3, region: S3Region.EuWest1, bucketName: 'bucket-1', vectorStore });

      // The first telemetry write is the syncing marker, keyed by (region,
      // bucketName). It must write syncState only — never the enablement `status`.
      const [region, name, update] = mockUpdateBucketTelemetry.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      expect(region).toBe(S3Region.EuWest1);
      expect(name).toBe('bucket-1');
      expect(update).toEqual({ syncState: 'syncing' });
      expect(update).not.toHaveProperty('status');
    });

    it('writes the success snapshot with filesIndexed + indexSize + lastSyncedAt', async () => {
      // Two new objects get indexed (added to the manifest), one stale object is
      // removed. filesIndexed should be the post-reconciliation manifest size (2),
      // and indexSize the sum of the two indexed objects' source bytes (10 + 25).
      mockLoadManifest.mockResolvedValue(
        manifestOf([
          { objectKey: 'gone.txt', etag: 'g', chunkKeys: ['gone.txt#0'], updatedAt: 'x' },
        ]),
      );
      mockListObjects.mockResolvedValue(
        page([
          { key: 'a.txt', etag: 'e1', sizeBytes: 10 },
          { key: 'b.txt', etag: 'e2', sizeBytes: 25 },
        ]),
      );

      const before = Date.now();
      await indexBucket({ s3, region: S3Region.EuWest1, bucketName: 'bucket-1', vectorStore });
      const after = Date.now();

      const success = telemetryCall('idle');
      expect(success).toBeDefined();
      const [region, name, update] = success! as [string, string, Record<string, unknown>];
      expect(region).toBe(S3Region.EuWest1);
      expect(name).toBe('bucket-1');
      // The success snapshot writes syncState=idle, never the enablement status.
      expect(update).not.toHaveProperty('status');
      expect(update.filesIndexed).toBe(2);
      expect(update.indexSize).toBe(35);
      const syncedMs = new Date(update.lastSyncedAt as string).getTime();
      expect(syncedMs).toBeGreaterThanOrEqual(before);
      expect(syncedMs).toBeLessThanOrEqual(after);
    });

    it('does NOT write a success snapshot when the run is checkpointed mid-bucket', async () => {
      mockLoadManifest.mockResolvedValue(manifestOf([]));
      mockListObjects.mockResolvedValue(page([{ key: 'a.txt', etag: 'e1' }], 'next-tok'));

      await indexBucket(
        { s3, region: S3Region.EuWest1, bucketName: 'bucket-1', vectorStore },
        {
          deadlineEpochMs: Date.now() - 1,
        },
      );

      // Syncing marker fired; no idle (success) snapshot on an incomplete run.
      expect(telemetryCall('syncing')).toBeDefined();
      expect(telemetryCall('idle')).toBeUndefined();
    });

    it('does NOT write a success snapshot on a resumed (partial) run', async () => {
      mockLoadCheckpoint.mockResolvedValue({
        pk: 'INDEXER_CHECKPOINT#bucket-1',
        sk: 'CHECKPOINT',
        bucketName: 'bucket-1',
        continuationToken: 'resume-tok',
        lastPageStartedAt: '2024-01-01T00:00:00.000Z',
        ttl: Math.floor(Date.now() / 1000) + 3600,
      });
      mockLoadManifest.mockResolvedValue(manifestOf([]));
      mockListObjects.mockResolvedValue(page([{ key: 'a.txt', etag: 'e1' }]));

      await indexBucket({ s3, region: S3Region.EuWest1, bucketName: 'bucket-1', vectorStore });

      // A resumed run's counts are not authoritative, so no idle (success) snapshot.
      expect(telemetryCall('idle')).toBeUndefined();
    });
  });
});
