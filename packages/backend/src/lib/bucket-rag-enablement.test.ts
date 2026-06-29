import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import {
  getBucketRagEnablement,
  setBucketRagEnablement,
  toEnablementResponse,
} from './bucket-rag-enablement.js';
import type { BucketRAGEnablementRecord } from './dynamo-records.js';
import { S3Region } from '@filone/shared';

function record(over: Partial<BucketRAGEnablementRecord> = {}): BucketRAGEnablementRecord {
  return {
    pk: 'BUCKET#eu-west-1#my-bucket',
    sk: 'RAG',
    orgId: 'org-1',
    status: 'active',
    filesIndexed: 5,
    indexSize: 1024,
    lastSyncedAt: '2026-06-22T12:00:00Z',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-22T12:00:00Z',
    ...over,
  };
}

describe('getBucketRagEnablement', () => {
  beforeEach(() => ddbMock.reset());

  it('reads BUCKET#{region}#{name}/RAG from UserInfoTable via a single GetItemCommand', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: marshall(record()) });

    const result = await getBucketRagEnablement(S3Region.EuWest1, 'my-bucket');

    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(GetItemCommand)[0]?.args[0].input).toEqual({
      TableName: 'UserInfoTable',
      Key: { pk: { S: 'BUCKET#eu-west-1#my-bucket' }, sk: { S: 'RAG' } },
    });
    expect(result?.status).toBe('active');
  });

  it('returns undefined when no enablement row exists', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    expect(await getBucketRagEnablement(S3Region.EuWest1, 'my-bucket')).toBeUndefined();
  });
});

describe('setBucketRagEnablement', () => {
  beforeEach(() => ddbMock.reset());

  it('creates a new active record with zeroed telemetry when none exists', async () => {
    ddbMock.on(PutItemCommand).resolves({});

    const result = await setBucketRagEnablement({
      region: S3Region.EuWest1,
      bucketName: 'my-bucket',
      orgId: 'org-1',
      enabled: true,
      existing: undefined,
    });

    expect(result.status).toBe('active');
    expect(result.pk).toBe('BUCKET#eu-west-1#my-bucket');
    expect(result.sk).toBe('RAG');
    expect(result.orgId).toBe('org-1');
    expect(result.filesIndexed).toBe(0);
    expect(result.indexSize).toBe(0);
    expect(result.createdAt).toBe(result.updatedAt);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
  });

  it('flips status to disabled while preserving telemetry + createdAt', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    const existing = record({ filesIndexed: 99, indexSize: 5000 });

    const result = await setBucketRagEnablement({
      region: S3Region.EuWest1,
      bucketName: 'my-bucket',
      orgId: 'org-1',
      enabled: false,
      existing,
    });

    expect(result.status).toBe('disabled');
    expect(result.filesIndexed).toBe(99);
    expect(result.indexSize).toBe(5000);
    expect(result.lastSyncedAt).toBe('2026-06-22T12:00:00Z');
    expect(result.createdAt).toBe('2026-06-01T00:00:00Z');
    expect(result.updatedAt).not.toBe('2026-06-01T00:00:00Z');
  });
});

describe('toEnablementResponse', () => {
  it('maps an active record to enabled:true with telemetry', () => {
    expect(toEnablementResponse(record())).toEqual({
      enabled: true,
      status: 'active',
      filesIndexed: 5,
      indexSize: 1024,
      lastSyncedAt: '2026-06-22T12:00:00Z',
    });
  });

  it('maps a missing record to a disabled, zeroed response', () => {
    expect(toEnablementResponse(undefined)).toEqual({
      enabled: false,
      status: 'disabled',
      filesIndexed: 0,
      indexSize: 0,
    });
  });

  it('omits lastSyncedAt when the record has never synced', () => {
    const result = toEnablementResponse(record({ lastSyncedAt: undefined }));
    expect(result).not.toHaveProperty('lastSyncedAt');
  });
});
