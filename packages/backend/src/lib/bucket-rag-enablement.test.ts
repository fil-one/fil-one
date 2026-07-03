import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    RagIndexerTable: { name: 'RagIndexerTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import {
  getBucketRagEnablement,
  setBucketRagEnablement,
  toEnablementResponse,
  updateBucketTelemetry,
} from './bucket-rag-enablement.js';
import type { BucketRAGEnablementRecord } from './dynamo-records.js';
import { S3Region } from '@filone/shared';

function record(over: Partial<BucketRAGEnablementRecord> = {}): BucketRAGEnablementRecord {
  return {
    pk: 'BUCKET#org-1#eu-west-1#bucket-1',
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

  it('reads BUCKET#{orgId}#{region}#{name}/RAG from RagIndexerTable via a single GetItemCommand', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: marshall(record()) });

    const result = await getBucketRagEnablement('org-1', S3Region.EuWest1, 'bucket-1');

    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(GetItemCommand)[0]?.args[0].input).toEqual({
      TableName: 'RagIndexerTable',
      Key: { pk: { S: 'BUCKET#org-1#eu-west-1#bucket-1' }, sk: { S: 'RAG' } },
    });
    expect(result?.status).toBe('active');
  });

  it('returns undefined when no enablement row exists', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    expect(await getBucketRagEnablement('org-1', S3Region.EuWest1, 'bucket-1')).toBeUndefined();
  });
});

describe('setBucketRagEnablement', () => {
  beforeEach(() => ddbMock.reset());

  it('creates a new active record with zeroed telemetry when none exists', async () => {
    ddbMock.on(PutItemCommand).resolves({});

    const result = await setBucketRagEnablement({
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      orgId: 'org-1',
      enabled: true,
      existing: undefined,
    });

    expect(result.status).toBe('active');
    expect(result.pk).toBe('BUCKET#org-1#eu-west-1#bucket-1');
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
      bucketName: 'bucket-1',
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
    expect(toEnablementResponse(record({ syncState: 'idle' }))).toEqual({
      enabled: true,
      status: 'active',
      syncState: 'idle',
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

  it('omits syncState when the record has never synced (never-synced renders as idle)', () => {
    const result = toEnablementResponse(record({ syncState: undefined }));
    expect(result).not.toHaveProperty('syncState');
  });

  it('reports an enabled bucket that is currently syncing as still enabled', () => {
    // Enablement (status) is decoupled from sync progress (syncState): a bucket
    // mid-sync stays enabled/queryable.
    const result = toEnablementResponse(record({ status: 'active', syncState: 'syncing' }));
    expect(result.enabled).toBe(true);
    expect(result.status).toBe('active');
    expect(result.syncState).toBe('syncing');
  });

  it('surfaces lastSyncError only when the syncState is error (status stays active)', () => {
    const errored = toEnablementResponse(
      record({ status: 'active', syncState: 'error', lastSyncError: 'Connection timeout' }),
    );
    // The failed sync does not flip enablement off.
    expect(errored.enabled).toBe(true);
    expect(errored.status).toBe('active');
    expect(errored.syncState).toBe('error');
    expect(errored.lastSyncError).toBe('Connection timeout');
  });

  it('omits lastSyncError for a non-error record even if one is stored', () => {
    const result = toEnablementResponse(
      record({ status: 'active', syncState: 'idle', lastSyncError: 'stale' }),
    );
    expect(result).not.toHaveProperty('lastSyncError');
  });
});

describe('setBucketRagEnablement (sync-state + lastSyncError preservation)', () => {
  beforeEach(() => ddbMock.reset());

  it('preserves a stored lastSyncError when toggling enablement', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    const existing = record({ status: 'active', syncState: 'error', lastSyncError: 'boom' });

    const result = await setBucketRagEnablement({
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      orgId: 'org-1',
      enabled: true,
      existing,
    });

    expect(result.lastSyncError).toBe('boom');
  });

  it('preserves the indexer-owned syncState when toggling enablement (decoupled)', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    const existing = record({ status: 'active', syncState: 'syncing' });

    // Disabling enablement must not disturb the indexer's sync progress.
    const result = await setBucketRagEnablement({
      region: S3Region.EuWest1,
      bucketName: 'bucket-1',
      orgId: 'org-1',
      enabled: false,
      existing,
    });

    expect(result.status).toBe('disabled');
    expect(result.syncState).toBe('syncing');
  });
});

describe('updateBucketTelemetry', () => {
  beforeEach(() => ddbMock.reset());

  /** Pull the single UpdateItemCommand input the call issued. */
  function lastUpdateInput() {
    const calls = ddbMock.commandCalls(UpdateItemCommand);
    expect(calls).toHaveLength(1);
    return calls[0]!.args[0].input;
  }

  it('targets BUCKET#{orgId}#{region}#{name}/RAG on RagIndexerTable and guards on the row existing', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await updateBucketTelemetry('org-1', S3Region.EuWest1, 'bucket-1', { syncState: 'syncing' });

    const input = lastUpdateInput();
    expect(input.TableName).toBe('RagIndexerTable');
    expect(input.Key).toEqual({ pk: { S: 'BUCKET#org-1#eu-west-1#bucket-1' }, sk: { S: 'RAG' } });
    // Only telemetry for an existing (RAG-enabled) row — never resurrects a deleted one.
    expect(input.ConditionExpression).toBe('attribute_exists(pk)');
  });

  it('writes syncState (NOT the enablement status) — status is left untouched', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await updateBucketTelemetry('org-1', S3Region.EuWest1, 'bucket-1', { syncState: 'syncing' });

    const input = lastUpdateInput();
    // The indexer must never modify the enablement source of truth.
    expect(input.UpdateExpression).not.toContain('status');
    expect(input.UpdateExpression).toContain('syncState = :syncState');
    expect(input.ExpressionAttributeValues).not.toHaveProperty(':status');
    // No reserved-word alias needed anymore (syncState is not a reserved word).
    expect(input.ExpressionAttributeNames).toBeUndefined();
  });

  it('marks a run in flight: SET syncState=syncing without touching the counters', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await updateBucketTelemetry('org-1', S3Region.EuWest1, 'bucket-1', { syncState: 'syncing' });

    const input = lastUpdateInput();
    // Atomic single-expression update via SET (no read-modify-write).
    expect(input.UpdateExpression).toContain('SET');
    expect(input.UpdateExpression).toContain('syncState = :syncState');
    expect(input.ExpressionAttributeValues?.[':syncState']).toEqual({ S: 'syncing' });
    // No counter writes on the syncing marker.
    expect(input.UpdateExpression).not.toContain('filesIndexed');
    expect(input.UpdateExpression).not.toContain('indexSize');
    // Stale error reason is cleared whenever we are not in the error state.
    expect(input.UpdateExpression).toContain('REMOVE lastSyncError');
  });

  it('writes the success snapshot: SET counters + lastSyncedAt + syncState=idle', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await updateBucketTelemetry('org-1', S3Region.EuWest1, 'bucket-1', {
      syncState: 'idle',
      filesIndexed: 42,
      indexSize: 1_048_576,
      lastSyncedAt: '2026-06-22T12:00:00Z',
    });

    const input = lastUpdateInput();
    const expr = input.UpdateExpression!;
    // Absolute snapshots use SET (last-write-wins), never a relative ADD that
    // would double-count across runs.
    expect(expr).toContain('filesIndexed = :files');
    expect(expr).toContain('indexSize = :size');
    expect(expr).toContain('lastSyncedAt = :synced');
    expect(expr).not.toContain('ADD');
    expect(input.ExpressionAttributeValues?.[':files']).toEqual({ N: '42' });
    expect(input.ExpressionAttributeValues?.[':size']).toEqual({ N: '1048576' });
    expect(input.ExpressionAttributeValues?.[':synced']).toEqual({ S: '2026-06-22T12:00:00Z' });
    expect(input.ExpressionAttributeValues?.[':syncState']).toEqual({ S: 'idle' });
    // Success clears any prior failure reason.
    expect(expr).toContain('REMOVE lastSyncError');
  });

  it('records a failure: SET syncState=error + lastSyncError, no REMOVE', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await updateBucketTelemetry('org-1', S3Region.EuWest1, 'bucket-1', {
      syncState: 'error',
      lastSyncError: 'Connection timeout',
    });

    const input = lastUpdateInput();
    expect(input.UpdateExpression).toContain('lastSyncError = :err');
    expect(input.UpdateExpression).not.toContain('REMOVE');
    expect(input.ExpressionAttributeValues?.[':syncState']).toEqual({ S: 'error' });
    expect(input.ExpressionAttributeValues?.[':err']).toEqual({ S: 'Connection timeout' });
  });

  it('truncates an oversized error message', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    const huge = 'x'.repeat(2000);

    await updateBucketTelemetry('org-1', S3Region.EuWest1, 'bucket-1', {
      syncState: 'error',
      lastSyncError: huge,
    });

    const stored = lastUpdateInput().ExpressionAttributeValues?.[':err'];
    expect(stored && 'S' in stored ? stored.S!.length : 0).toBe(500);
  });

  it('is a no-op when the enablement row does not exist (disabled mid-run)', async () => {
    ddbMock
      .on(UpdateItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'no row', $metadata: {} }));

    // Must not throw — a disabled bucket simply has no telemetry row to update.
    await expect(
      updateBucketTelemetry('org-1', S3Region.EuWest1, 'gone', { syncState: 'syncing' }),
    ).resolves.toBeUndefined();
  });

  it('rethrows non-conditional DynamoDB failures', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('throttled'));
    await expect(
      updateBucketTelemetry('org-1', S3Region.EuWest1, 'bucket-1', { syncState: 'syncing' }),
    ).rejects.toThrow('throttled');
  });
});
