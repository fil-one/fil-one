import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: { UserInfoTable: { name: 'UserInfoTable' } },
}));

const ddbMock = mockClient(DynamoDBClient);

import {
  clearCheckpoint,
  deleteManifestEntry,
  loadCheckpoint,
  loadManifest,
  saveCheckpoint,
  saveManifestEntry,
} from './rag-indexer-manifest.js';
import { S3Region } from '@filone/shared';

function manifestRow(objectKey: string, etag: string, chunkKeys: string[]) {
  return marshall({
    pk: `BUCKET#eu-west-1#bucket-1`,
    sk: `MANIFEST#${objectKey}`,
    objectKey,
    etag,
    chunkKeys,
    chunkCount: chunkKeys.length,
    updatedAt: '2024-01-01T00:00:00.000Z',
  });
}

describe('rag-indexer-manifest', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
  });

  describe('loadManifest', () => {
    it('queries by pk + begins_with MANIFEST# and maps rows by objectKey', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [manifestRow('a.txt', 'e1', ['a.txt#0']), manifestRow('b.txt', 'e2', ['b.txt#0'])],
      });

      const manifest = await loadManifest(S3Region.EuWest1, 'bucket-1');

      const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
      expect(input.KeyConditionExpression).toContain('begins_with(sk, :prefix)');
      expect(input.ExpressionAttributeValues).toMatchObject({
        ':pk': { S: 'BUCKET#eu-west-1#bucket-1' },
        ':prefix': { S: 'MANIFEST#' },
      });
      expect(manifest.get('a.txt')).toEqual({
        objectKey: 'a.txt',
        etag: 'e1',
        chunkKeys: ['a.txt#0'],
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(manifest.size).toBe(2);
    });

    it('pages through the query', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({
          Items: [manifestRow('a.txt', 'e1', ['a.txt#0'])],
          LastEvaluatedKey: marshall({ pk: 'BUCKET#eu-west-1#bucket-1', sk: 'MANIFEST#a.txt' }),
        })
        .resolvesOnce({ Items: [manifestRow('b.txt', 'e2', ['b.txt#0'])] });

      const manifest = await loadManifest(S3Region.EuWest1, 'bucket-1');

      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
      expect(manifest.size).toBe(2);
    });
  });

  describe('saveManifestEntry / deleteManifestEntry', () => {
    it('writes the manifest row with etag, chunk keys and count', async () => {
      ddbMock.on(PutItemCommand).resolves({});

      await saveManifestEntry(S3Region.EuWest1, 'bucket-1', 'a.txt', 'e9', ['a.txt#0', 'a.txt#1']);

      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.pk).toEqual({ S: 'BUCKET#eu-west-1#bucket-1' });
      expect(item.sk).toEqual({ S: 'MANIFEST#a.txt' });
      expect(item.etag).toEqual({ S: 'e9' });
      expect(item.chunkCount).toEqual({ N: '2' });
    });

    it('deletes by explicit manifest key', async () => {
      ddbMock.on(DeleteItemCommand).resolves({});

      await deleteManifestEntry(S3Region.EuWest1, 'bucket-1', 'a.txt');

      expect(ddbMock.commandCalls(DeleteItemCommand)[0].args[0].input.Key).toEqual({
        pk: { S: 'BUCKET#eu-west-1#bucket-1' },
        sk: { S: 'MANIFEST#a.txt' },
      });
    });
  });

  describe('checkpoints', () => {
    it('persists the continuation token with a TTL', async () => {
      ddbMock.on(PutItemCommand).resolves({});

      await saveCheckpoint(S3Region.EuWest1, 'bucket-1', 'tok-1');

      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.pk).toEqual({ S: 'INDEXER_CHECKPOINT#eu-west-1#bucket-1' });
      expect(item.sk).toEqual({ S: 'CHECKPOINT' });
      expect(item.continuationToken).toEqual({ S: 'tok-1' });
      expect(Number(item.ttl!.N)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('omits the continuation token when undefined', async () => {
      ddbMock.on(PutItemCommand).resolves({});

      await saveCheckpoint(S3Region.EuWest1, 'bucket-1', undefined);

      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.continuationToken).toBeUndefined();
    });

    it('loads a live checkpoint', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: marshall({
          pk: 'INDEXER_CHECKPOINT#eu-west-1#bucket-1',
          sk: 'CHECKPOINT',
          bucketName: 'bucket-1',
          continuationToken: 'tok-9',
          lastPageStartedAt: '2024-01-01T00:00:00.000Z',
          ttl: Math.floor(Date.now() / 1000) + 3600,
        }),
      });

      const checkpoint = await loadCheckpoint(S3Region.EuWest1, 'bucket-1');

      expect(checkpoint?.continuationToken).toBe('tok-9');
      expect(ddbMock.commandCalls(GetItemCommand)[0].args[0].input.Key).toEqual({
        pk: { S: 'INDEXER_CHECKPOINT#eu-west-1#bucket-1' },
        sk: { S: 'CHECKPOINT' },
      });
    });

    it('treats an expired checkpoint as absent', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: marshall({
          pk: 'INDEXER_CHECKPOINT#eu-west-1#bucket-1',
          sk: 'CHECKPOINT',
          bucketName: 'bucket-1',
          continuationToken: 'stale',
          lastPageStartedAt: '2020-01-01T00:00:00.000Z',
          ttl: Math.floor(Date.now() / 1000) - 10,
        }),
      });

      expect(await loadCheckpoint(S3Region.EuWest1, 'bucket-1')).toBeUndefined();
    });

    it('returns undefined when no checkpoint exists', async () => {
      ddbMock.on(GetItemCommand).resolves({});

      expect(await loadCheckpoint(S3Region.EuWest1, 'bucket-1')).toBeUndefined();
    });

    it('clears the checkpoint row', async () => {
      ddbMock.on(DeleteItemCommand).resolves({});

      await clearCheckpoint(S3Region.EuWest1, 'bucket-1');

      expect(ddbMock.commandCalls(DeleteItemCommand)[0].args[0].input.Key).toEqual({
        pk: { S: 'INDEXER_CHECKPOINT#eu-west-1#bucket-1' },
        sk: { S: 'CHECKPOINT' },
      });
    });
  });
});
