import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BatchWriteItemCommand,
  DynamoDBClient,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: { RagIndexerTable: { name: 'RagIndexerTable' } },
}));

const ddbMock = mockClient(DynamoDBClient);
const ORG = 'org-1';

import {
  clearCheckpoint,
  deleteAllManifestEntries,
  deleteManifestEntry,
  loadCheckpoint,
  loadManifest,
  saveCheckpoint,
  saveManifestEntry,
} from './rag-indexer-manifest.js';
import { S3Region } from '@filone/shared';

function manifestRow(objectKey: string, etag: string, chunkKeys: string[]) {
  return marshall({
    pk: `BUCKET#org-1#eu-west-1#bucket-1`,
    sk: `MANIFEST2#${objectKey}`,
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
    it('queries by pk + begins_with MANIFEST2# and maps rows by objectKey', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [manifestRow('a.txt', 'e1', ['a.txt#0']), manifestRow('b.txt', 'e2', ['b.txt#0'])],
      });

      const manifest = await loadManifest(ORG, S3Region.EuWest1, 'bucket-1');

      const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
      expect(input.KeyConditionExpression).toContain('begins_with(sk, :prefix)');
      expect(input.ExpressionAttributeValues).toMatchObject({
        ':pk': { S: 'BUCKET#org-1#eu-west-1#bucket-1' },
        ':prefix': { S: 'MANIFEST2#' },
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
          LastEvaluatedKey: marshall({
            pk: 'BUCKET#org-1#eu-west-1#bucket-1',
            sk: 'MANIFEST2#a.txt',
          }),
        })
        .resolvesOnce({ Items: [manifestRow('b.txt', 'e2', ['b.txt#0'])] });

      const manifest = await loadManifest(ORG, S3Region.EuWest1, 'bucket-1');

      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
      expect(manifest.size).toBe(2);
    });
  });

  describe('saveManifestEntry / deleteManifestEntry', () => {
    it('writes the manifest row with etag, chunk keys and count', async () => {
      ddbMock.on(PutItemCommand).resolves({});

      await saveManifestEntry(ORG, S3Region.EuWest1, 'bucket-1', {
        objectKey: 'a.txt',
        etag: 'e9',
        chunkKeys: ['a.txt#0', 'a.txt#1'],
      });

      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.pk).toEqual({ S: 'BUCKET#org-1#eu-west-1#bucket-1' });
      expect(item.sk).toEqual({ S: 'MANIFEST2#a.txt' });
      expect(item.etag).toEqual({ S: 'e9' });
      expect(item.chunkCount).toEqual({ N: '2' });
    });

    it('deletes by explicit manifest key', async () => {
      ddbMock.on(DeleteItemCommand).resolves({});

      await deleteManifestEntry(ORG, S3Region.EuWest1, 'bucket-1', 'a.txt');

      expect(ddbMock.commandCalls(DeleteItemCommand)[0].args[0].input.Key).toEqual({
        pk: { S: 'BUCKET#org-1#eu-west-1#bucket-1' },
        sk: { S: 'MANIFEST2#a.txt' },
      });
    });
  });

  describe('checkpoints', () => {
    it('persists the continuation token with a TTL', async () => {
      ddbMock.on(PutItemCommand).resolves({});

      await saveCheckpoint(ORG, S3Region.EuWest1, 'bucket-1', 'tok-1');

      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.pk).toEqual({ S: 'INDEXER_CHECKPOINT#org-1#eu-west-1#bucket-1' });
      expect(item.sk).toEqual({ S: 'CHECKPOINT2' });
      expect(item.continuationToken).toEqual({ S: 'tok-1' });
      expect(Number(item.ttl!.N)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('omits the continuation token when undefined', async () => {
      ddbMock.on(PutItemCommand).resolves({});

      await saveCheckpoint(ORG, S3Region.EuWest1, 'bucket-1', undefined);

      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.continuationToken).toBeUndefined();
    });

    it('loads a live checkpoint', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: marshall({
          pk: 'INDEXER_CHECKPOINT#org-1#eu-west-1#bucket-1',
          sk: 'CHECKPOINT2',
          orgId: 'org-1',
          region: S3Region.EuWest1,
          bucketName: 'bucket-1',
          continuationToken: 'tok-9',
          lastPageStartedAt: '2024-01-01T00:00:00.000Z',
          ttl: Math.floor(Date.now() / 1000) + 3600,
        }),
      });

      const checkpoint = await loadCheckpoint(ORG, S3Region.EuWest1, 'bucket-1');

      expect(checkpoint?.continuationToken).toBe('tok-9');
      expect(ddbMock.commandCalls(GetItemCommand)[0].args[0].input.Key).toEqual({
        pk: { S: 'INDEXER_CHECKPOINT#org-1#eu-west-1#bucket-1' },
        sk: { S: 'CHECKPOINT2' },
      });
    });

    it('treats an expired checkpoint as absent', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: marshall({
          pk: 'INDEXER_CHECKPOINT#org-1#eu-west-1#bucket-1',
          sk: 'CHECKPOINT2',
          orgId: 'org-1',
          region: S3Region.EuWest1,
          bucketName: 'bucket-1',
          continuationToken: 'stale',
          lastPageStartedAt: '2020-01-01T00:00:00.000Z',
          ttl: Math.floor(Date.now() / 1000) - 10,
        }),
      });

      expect(await loadCheckpoint(ORG, S3Region.EuWest1, 'bucket-1')).toBeUndefined();
    });

    it('returns undefined when no checkpoint exists', async () => {
      ddbMock.on(GetItemCommand).resolves({});

      expect(await loadCheckpoint(ORG, S3Region.EuWest1, 'bucket-1')).toBeUndefined();
    });

    it('clears the checkpoint row', async () => {
      ddbMock.on(DeleteItemCommand).resolves({});

      await clearCheckpoint(ORG, S3Region.EuWest1, 'bucket-1');

      expect(ddbMock.commandCalls(DeleteItemCommand)[0].args[0].input.Key).toEqual({
        pk: { S: 'INDEXER_CHECKPOINT#org-1#eu-west-1#bucket-1' },
        sk: { S: 'CHECKPOINT2' },
      });
    });
  });
});

describe('deleteAllManifestEntries', () => {
  beforeEach(() => ddbMock.reset());

  it('pages the MANIFEST2# query and BatchWrite-deletes every row', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [
          { pk: { S: 'BUCKET#org-1#eu-west-1#bucket-1' }, sk: { S: 'MANIFEST2#a.txt' } },
          { pk: { S: 'BUCKET#org-1#eu-west-1#bucket-1' }, sk: { S: 'MANIFEST2#b.txt' } },
        ],
        LastEvaluatedKey: { pk: { S: 'x' }, sk: { S: 'y' } },
      })
      .resolvesOnce({
        Items: [{ pk: { S: 'BUCKET#org-1#eu-west-1#bucket-1' }, sk: { S: 'MANIFEST2#c.txt' } }],
      });
    ddbMock.on(BatchWriteItemCommand).resolves({});

    await deleteAllManifestEntries(ORG, S3Region.EuWest1, 'bucket-1');

    const query = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(query.KeyConditionExpression).toContain('begins_with(sk, :prefix)');
    expect(query.ExpressionAttributeValues![':prefix']).toEqual({ S: 'MANIFEST2#' });

    const batches = ddbMock.commandCalls(BatchWriteItemCommand);
    expect(batches).toHaveLength(2);
    const deleted = batches
      .flatMap((c) => c.args[0].input.RequestItems!['RagIndexerTable']!)
      .map((r) => r.DeleteRequest!.Key!.sk.S)
      .sort((a, b) => a!.localeCompare(b!));
    expect(deleted).toEqual(['MANIFEST2#a.txt', 'MANIFEST2#b.txt', 'MANIFEST2#c.txt']);
  });

  it('resubmits UnprocessedItems returned by a throttled batch', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ pk: { S: 'BUCKET#org-1#eu-west-1#bucket-1' }, sk: { S: 'MANIFEST2#a.txt' } }],
    });
    const key = { pk: { S: 'BUCKET#org-1#eu-west-1#bucket-1' }, sk: { S: 'MANIFEST2#a.txt' } };
    ddbMock
      .on(BatchWriteItemCommand)
      .resolvesOnce({ UnprocessedItems: { RagIndexerTable: [{ DeleteRequest: { Key: key } }] } })
      .resolvesOnce({});

    await deleteAllManifestEntries(ORG, S3Region.EuWest1, 'bucket-1');

    expect(ddbMock.commandCalls(BatchWriteItemCommand)).toHaveLength(2);
  });

  it('no-ops when there are no manifest rows', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await deleteAllManifestEntries(ORG, S3Region.EuWest1, 'bucket-1');

    expect(ddbMock.commandCalls(BatchWriteItemCommand)).toHaveLength(0);
  });
});
