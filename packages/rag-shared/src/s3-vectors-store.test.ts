import {
  ConflictException,
  CreateIndexCommand,
  DeleteIndexCommand,
  DeleteVectorsCommand,
  PutVectorsCommand,
  type QueryOutputVector,
  QueryVectorsCommand,
  S3VectorsClient,
} from '@aws-sdk/client-s3vectors';
import { createHash } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EMBEDDING_DIMENSION, MAX_METADATA_BYTES } from './constants.js';
import { S3VectorsStore } from './s3-vectors-store.js';

const VECTOR_BUCKET = 'rag-vectors';
const ORG = 'org-abc';
const REGION = 'eu-west-1';
const INDEX = 'bucket-1';

// The index name is a charset/length-safe hash of the (orgId, region, bucketName)
// triple (S3 Vectors names are 3–63 chars from [a-z0-9-.]). Mirror the store's
// derivation so assertions pin the format without hardcoding a digest.
function expectedIndexName(orgId: string, region: string, bucketName: string): string {
  const digest = createHash('sha256').update([orgId, region, bucketName].join(':')).digest('hex');
  return `rag-${digest.slice(0, 56)}`;
}
// Tenant-scoped index name for the common (ORG, REGION, INDEX) fixture.
const QUALIFIED_INDEX = expectedIndexName(ORG, REGION, INDEX);

const s3vMock = mockClient(S3VectorsClient);

function embedding(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSION }, () => 0.1);
}

function makeStore(): S3VectorsStore {
  return new S3VectorsStore(VECTOR_BUCKET, s3vMock as unknown as S3VectorsClient);
}

// S3 Vectors' types mark `key` as required and `distance` as a number, but the
// service can return entries missing either; this casts such malformed entries
// so tests can exercise the store's defensive filtering.
function malformed(vector: Record<string, unknown>): QueryOutputVector {
  return vector as unknown as QueryOutputVector;
}

describe('S3VectorsStore', () => {
  beforeEach(() => {
    s3vMock.reset();
  });

  it('requires a vector bucket name', () => {
    expect(() => new S3VectorsStore('')).toThrow(/vector bucket name/);
  });

  describe('ensureIndex', () => {
    it('creates a 1024-dim cosine float32 index with text non-filterable', async () => {
      s3vMock.on(CreateIndexCommand).resolves({});
      await makeStore().ensureIndex(ORG, REGION, INDEX);

      const calls = s3vMock.commandCalls(CreateIndexCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0]!.input).toMatchObject({
        vectorBucketName: VECTOR_BUCKET,
        indexName: QUALIFIED_INDEX,
        dataType: 'float32',
        dimension: EMBEDDING_DIMENSION,
        distanceMetric: 'cosine',
        metadataConfiguration: { nonFilterableMetadataKeys: ['text'] },
      });
    });

    it('is idempotent: an existing index (ConflictException) does not throw but warns', async () => {
      s3vMock
        .on(CreateIndexCommand)
        .rejects(new ConflictException({ message: 'index exists', $metadata: {} }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await expect(makeStore().ensureIndex(ORG, REGION, INDEX)).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('ConflictException'),
          expect.objectContaining({ orgId: ORG, region: REGION, bucketName: INDEX }),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('propagates non-conflict errors', async () => {
      s3vMock.on(CreateIndexCommand).rejects(new Error('boom'));
      await expect(makeStore().ensureIndex(ORG, REGION, INDEX)).rejects.toThrow('boom');
    });
  });

  describe('index-name tenant isolation (FIL-596)', () => {
    it('produces a charset/length-valid S3 Vectors index name', async () => {
      s3vMock.on(CreateIndexCommand).resolves({});
      await makeStore().ensureIndex(ORG, REGION, INDEX);
      const { indexName } = s3vMock.commandCalls(CreateIndexCommand)[0]!.args[0]!.input;
      // 3–63 chars, [a-z0-9-.], begins and ends alphanumeric.
      expect(indexName).toMatch(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
      expect(indexName!.length).toBeLessThanOrEqual(63);
    });

    it('gives two orgs distinct indexes for the same region+bucketName', async () => {
      s3vMock.on(CreateIndexCommand).resolves({});
      const store = makeStore();
      await store.ensureIndex('org-a', REGION, INDEX);
      await store.ensureIndex('org-b', REGION, INDEX);
      const [a, b] = s3vMock
        .commandCalls(CreateIndexCommand)
        .map((c) => c.args[0]!.input.indexName);
      expect(a).not.toBe(b);
    });
  });

  describe('upsertChunks', () => {
    it('formats vector keys as objectKey#chunkIndex and stores objectKey + text metadata', async () => {
      s3vMock.on(PutVectorsCommand).resolves({});
      await makeStore().upsertChunks(ORG, REGION, INDEX, [
        {
          key: 'doc.pdf#0',
          text: 'hello world',
          metadata: { page: 1 },
          embedding: embedding(),
        },
      ]);

      const calls = s3vMock.commandCalls(PutVectorsCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0]!.input;
      expect(input.vectorBucketName).toBe(VECTOR_BUCKET);
      expect(input.indexName).toBe(QUALIFIED_INDEX);
      expect(input.vectors).toHaveLength(1);
      const vector = input.vectors![0]!;
      expect(vector.key).toBe('doc.pdf#0');
      expect(vector.data).toEqual({ float32: embedding() });
      expect(vector.metadata).toMatchObject({
        page: 1,
        objectKey: 'doc.pdf',
        text: 'hello world',
      });
    });

    it('derives objectKey using the final # so keys with # in the object name survive', async () => {
      s3vMock.on(PutVectorsCommand).resolves({});
      await makeStore().upsertChunks(ORG, REGION, INDEX, [
        { key: 'a#b/c.txt#3', text: 't', metadata: {}, embedding: embedding() },
      ]);

      const vector = s3vMock.commandCalls(PutVectorsCommand)[0]!.args[0]!.input.vectors![0]!;
      expect((vector.metadata as Record<string, unknown>).objectKey).toBe('a#b/c.txt');
    });

    it('rejects a chunk whose serialized metadata exceeds 40KB', async () => {
      s3vMock.on(PutVectorsCommand).resolves({});
      const huge = 'x'.repeat(MAX_METADATA_BYTES + 1);
      await expect(
        makeStore().upsertChunks(ORG, REGION, INDEX, [
          { key: 'doc.pdf#0', text: huge, metadata: {}, embedding: embedding() },
        ]),
      ).rejects.toThrow(/40KB|per-vector limit/);
      expect(s3vMock.commandCalls(PutVectorsCommand)).toHaveLength(0);
    });

    it('rejects a chunk missing its embedding', async () => {
      s3vMock.on(PutVectorsCommand).resolves({});
      await expect(
        makeStore().upsertChunks(ORG, REGION, INDEX, [
          { key: 'doc.pdf#0', text: 't', metadata: {} },
        ]),
      ).rejects.toThrow(/missing an embedding/);
    });

    it('no-ops on empty input', async () => {
      await makeStore().upsertChunks(ORG, REGION, INDEX, []);
      expect(s3vMock.commandCalls(PutVectorsCommand)).toHaveLength(0);
    });
  });

  describe('deleteChunks', () => {
    it('deletes only by explicit keys', async () => {
      s3vMock.on(DeleteVectorsCommand).resolves({});
      await makeStore().deleteChunks(ORG, REGION, INDEX, ['doc.pdf#0', 'doc.pdf#2']);

      const calls = s3vMock.commandCalls(DeleteVectorsCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0]!.input).toMatchObject({
        vectorBucketName: VECTOR_BUCKET,
        indexName: QUALIFIED_INDEX,
        keys: ['doc.pdf#0', 'doc.pdf#2'],
      });
    });

    it('no-ops on empty keys', async () => {
      await makeStore().deleteChunks(ORG, REGION, INDEX, []);
      expect(s3vMock.commandCalls(DeleteVectorsCommand)).toHaveLength(0);
    });
  });

  describe('upsert then explicit-key delete', () => {
    it('leaves the other chunk queryable after deleting one by key', async () => {
      s3vMock.on(PutVectorsCommand).resolves({});
      s3vMock.on(DeleteVectorsCommand).resolves({});
      s3vMock.on(QueryVectorsCommand).resolves({
        vectors: [
          { key: 'doc.pdf#1', distance: 0.05, metadata: { text: 'second', objectKey: 'doc.pdf' } },
        ],
      });

      const store = makeStore();
      await store.upsertChunks(ORG, REGION, INDEX, [
        { key: 'doc.pdf#0', text: 'first', metadata: {}, embedding: embedding() },
        { key: 'doc.pdf#1', text: 'second', metadata: {}, embedding: embedding() },
      ]);
      await store.deleteChunks(ORG, REGION, INDEX, ['doc.pdf#0']);

      const deleted = s3vMock.commandCalls(DeleteVectorsCommand)[0]!.args[0]!.input;
      expect(deleted.keys).toEqual(['doc.pdf#0']);

      const results = await store.query(ORG, REGION, INDEX, { embedding: embedding(), k: 5 });
      expect(results.map((r) => r.key)).toEqual(['doc.pdf#1']);
    });
  });

  describe('query', () => {
    it('returns k-NN results with text split out of metadata and distance as score', async () => {
      s3vMock.on(QueryVectorsCommand).resolves({
        vectors: [
          {
            key: 'doc.pdf#0',
            distance: 0.12,
            metadata: { text: 'chunk text', objectKey: 'doc.pdf', page: 2 },
          },
        ],
      });

      const results = await makeStore().query(ORG, REGION, INDEX, {
        embedding: embedding(),
        k: 3,
        filters: { objectKey: 'doc.pdf' },
      });

      const input = s3vMock.commandCalls(QueryVectorsCommand)[0]!.args[0]!.input;
      expect(input).toMatchObject({
        vectorBucketName: VECTOR_BUCKET,
        indexName: QUALIFIED_INDEX,
        topK: 3,
        queryVector: { float32: embedding() },
        returnMetadata: true,
        returnDistance: true,
        filter: { objectKey: 'doc.pdf' },
      });

      expect(results).toEqual([
        {
          key: 'doc.pdf#0',
          text: 'chunk text',
          metadata: { objectKey: 'doc.pdf', page: 2 },
          score: 0.12,
        },
      ]);
    });

    it('omits the filter when none is provided and tolerates missing vectors', async () => {
      s3vMock.on(QueryVectorsCommand).resolves({});
      const results = await makeStore().query(ORG, REGION, INDEX, { embedding: embedding(), k: 1 });
      expect(results).toEqual([]);
      expect(s3vMock.commandCalls(QueryVectorsCommand)[0]!.args[0]!.input.filter).toBeUndefined();
    });

    it('drops a result with a missing key', async () => {
      s3vMock.on(QueryVectorsCommand).resolves({
        vectors: [malformed({ distance: 0.1, metadata: { text: 'orphan', objectKey: 'doc.pdf' } })],
      });
      const results = await makeStore().query(ORG, REGION, INDEX, { embedding: embedding(), k: 5 });
      expect(results).toEqual([]);
    });

    it('drops a result with an empty-string key', async () => {
      s3vMock.on(QueryVectorsCommand).resolves({
        vectors: [{ key: '', distance: 0.1, metadata: { text: 'orphan', objectKey: 'doc.pdf' } }],
      });
      const results = await makeStore().query(ORG, REGION, INDEX, { embedding: embedding(), k: 5 });
      expect(results).toEqual([]);
    });

    it('drops a result with a null distance', async () => {
      s3vMock.on(QueryVectorsCommand).resolves({
        vectors: [
          malformed({
            key: 'doc.pdf#0',
            distance: null,
            metadata: { text: 'no score', objectKey: 'doc.pdf' },
          }),
        ],
      });
      const results = await makeStore().query(ORG, REGION, INDEX, { embedding: embedding(), k: 5 });
      expect(results).toEqual([]);
    });

    it('drops a result with the distance field absent (undefined)', async () => {
      s3vMock.on(QueryVectorsCommand).resolves({
        vectors: [
          malformed({ key: 'doc.pdf#0', metadata: { text: 'no score', objectKey: 'doc.pdf' } }),
        ],
      });
      const results = await makeStore().query(ORG, REGION, INDEX, { embedding: embedding(), k: 5 });
      expect(results).toEqual([]);
    });

    it('keeps valid results and drops the keyless / scoreless ones in the same batch', async () => {
      s3vMock.on(QueryVectorsCommand).resolves({
        vectors: [
          { key: 'doc.pdf#0', distance: 0.1, metadata: { text: 'good', objectKey: 'doc.pdf' } },
          malformed({ distance: 0.2, metadata: { text: 'no key', objectKey: 'doc.pdf' } }),
          malformed({
            key: 'doc.pdf#2',
            distance: null,
            metadata: { text: 'no score', objectKey: 'doc.pdf' },
          }),
          {
            key: 'doc.pdf#3',
            distance: 0.4,
            metadata: { text: 'also good', objectKey: 'doc.pdf' },
          },
        ],
      });
      const results = await makeStore().query(ORG, REGION, INDEX, { embedding: embedding(), k: 5 });
      expect(results).toEqual([
        { key: 'doc.pdf#0', text: 'good', metadata: { objectKey: 'doc.pdf' }, score: 0.1 },
        { key: 'doc.pdf#3', text: 'also good', metadata: { objectKey: 'doc.pdf' }, score: 0.4 },
      ]);
    });

    it('preserves a legitimate zero distance (exact match)', async () => {
      s3vMock.on(QueryVectorsCommand).resolves({
        vectors: [
          { key: 'doc.pdf#0', distance: 0, metadata: { text: 'identical', objectKey: 'doc.pdf' } },
        ],
      });
      const results = await makeStore().query(ORG, REGION, INDEX, { embedding: embedding(), k: 5 });
      expect(results).toEqual([
        { key: 'doc.pdf#0', text: 'identical', metadata: { objectKey: 'doc.pdf' }, score: 0 },
      ]);
    });
  });

  describe('dropIndex', () => {
    it('deletes the index', async () => {
      s3vMock.on(DeleteIndexCommand).resolves({});
      await makeStore().dropIndex(ORG, REGION, INDEX);
      expect(s3vMock.commandCalls(DeleteIndexCommand)[0]!.args[0]!.input).toMatchObject({
        vectorBucketName: VECTOR_BUCKET,
        indexName: QUALIFIED_INDEX,
      });
    });
  });
});
