import {
  ConflictException,
  CreateIndexCommand,
  DeleteIndexCommand,
  DeleteVectorsCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
  S3VectorsClient,
} from '@aws-sdk/client-s3vectors';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { EMBEDDING_DIMENSION, MAX_METADATA_BYTES } from './constants.js';
import { S3VectorsStore } from './s3-vectors-store.js';

const VECTOR_BUCKET = 'rag-vectors';
const REGION = 'eu-west-1';
const INDEX = 'bucket-1';
// Bucket names are unique per region, so the index is region-qualified.
const QUALIFIED_INDEX = `${REGION}:${INDEX}`;

const s3vMock = mockClient(S3VectorsClient);

function embedding(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSION }, () => 0.1);
}

function makeStore(): S3VectorsStore {
  return new S3VectorsStore(VECTOR_BUCKET, s3vMock as unknown as S3VectorsClient);
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
      await makeStore().ensureIndex(REGION, INDEX);

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

    it('is idempotent: an existing index (ConflictException) does not throw', async () => {
      s3vMock
        .on(CreateIndexCommand)
        .rejects(new ConflictException({ message: 'index exists', $metadata: {} }));
      await expect(makeStore().ensureIndex(REGION, INDEX)).resolves.toBeUndefined();
    });

    it('propagates non-conflict errors', async () => {
      s3vMock.on(CreateIndexCommand).rejects(new Error('boom'));
      await expect(makeStore().ensureIndex(REGION, INDEX)).rejects.toThrow('boom');
    });
  });

  describe('upsertChunks', () => {
    it('formats vector keys as objectKey#chunkIndex and stores objectKey + text metadata', async () => {
      s3vMock.on(PutVectorsCommand).resolves({});
      await makeStore().upsertChunks(REGION, INDEX, [
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
      await makeStore().upsertChunks(REGION, INDEX, [
        { key: 'a#b/c.txt#3', text: 't', metadata: {}, embedding: embedding() },
      ]);

      const vector = s3vMock.commandCalls(PutVectorsCommand)[0]!.args[0]!.input.vectors![0]!;
      expect((vector.metadata as Record<string, unknown>).objectKey).toBe('a#b/c.txt');
    });

    it('rejects a chunk whose serialized metadata exceeds 40KB', async () => {
      s3vMock.on(PutVectorsCommand).resolves({});
      const huge = 'x'.repeat(MAX_METADATA_BYTES + 1);
      await expect(
        makeStore().upsertChunks(REGION, INDEX, [
          { key: 'doc.pdf#0', text: huge, metadata: {}, embedding: embedding() },
        ]),
      ).rejects.toThrow(/40KB|per-vector limit/);
      expect(s3vMock.commandCalls(PutVectorsCommand)).toHaveLength(0);
    });

    it('rejects a chunk missing its embedding', async () => {
      s3vMock.on(PutVectorsCommand).resolves({});
      await expect(
        makeStore().upsertChunks(REGION, INDEX, [{ key: 'doc.pdf#0', text: 't', metadata: {} }]),
      ).rejects.toThrow(/missing an embedding/);
    });

    it('no-ops on empty input', async () => {
      await makeStore().upsertChunks(REGION, INDEX, []);
      expect(s3vMock.commandCalls(PutVectorsCommand)).toHaveLength(0);
    });
  });

  describe('deleteChunks', () => {
    it('deletes only by explicit keys', async () => {
      s3vMock.on(DeleteVectorsCommand).resolves({});
      await makeStore().deleteChunks(REGION, INDEX, ['doc.pdf#0', 'doc.pdf#2']);

      const calls = s3vMock.commandCalls(DeleteVectorsCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0]!.input).toMatchObject({
        vectorBucketName: VECTOR_BUCKET,
        indexName: QUALIFIED_INDEX,
        keys: ['doc.pdf#0', 'doc.pdf#2'],
      });
    });

    it('no-ops on empty keys', async () => {
      await makeStore().deleteChunks(REGION, INDEX, []);
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
      await store.upsertChunks(REGION, INDEX, [
        { key: 'doc.pdf#0', text: 'first', metadata: {}, embedding: embedding() },
        { key: 'doc.pdf#1', text: 'second', metadata: {}, embedding: embedding() },
      ]);
      await store.deleteChunks(REGION, INDEX, ['doc.pdf#0']);

      const deleted = s3vMock.commandCalls(DeleteVectorsCommand)[0]!.args[0]!.input;
      expect(deleted.keys).toEqual(['doc.pdf#0']);

      const results = await store.query(REGION, INDEX, embedding(), 5);
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

      const results = await makeStore().query(REGION, INDEX, embedding(), 3, {
        objectKey: 'doc.pdf',
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
      const results = await makeStore().query(REGION, INDEX, embedding(), 1);
      expect(results).toEqual([]);
      expect(s3vMock.commandCalls(QueryVectorsCommand)[0]!.args[0]!.input.filter).toBeUndefined();
    });
  });

  describe('dropIndex', () => {
    it('deletes the index', async () => {
      s3vMock.on(DeleteIndexCommand).resolves({});
      await makeStore().dropIndex(REGION, INDEX);
      expect(s3vMock.commandCalls(DeleteIndexCommand)[0]!.args[0]!.input).toMatchObject({
        vectorBucketName: VECTOR_BUCKET,
        indexName: QUALIFIED_INDEX,
      });
    });
  });
});
