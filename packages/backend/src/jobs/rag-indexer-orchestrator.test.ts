import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { RagIndexerWorkerPayload } from './rag-indexer-worker.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

vi.stubEnv('RAG_INDEXER_WORKER_FUNCTION_NAME', 'rag-indexer-worker-fn');

const ddbMock = mockClient(DynamoDBClient);
const lambdaMock = mockClient(LambdaClient);

import { handler } from './rag-indexer-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enablementItem(
  bucketName: string,
  orgId: string,
  extra: Record<string, unknown> = {},
  region = 'eu-west-1',
) {
  return marshall(
    {
      pk: `BUCKET#${orgId}#${region}#${bucketName}`,
      sk: 'RAG',
      orgId,
      status: 'active',
      filesIndexed: 0,
      indexSize: 0,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      ...extra,
    },
    { removeUndefinedValues: true },
  );
}

function payloadsFrom(): RagIndexerWorkerPayload[] {
  return lambdaMock
    .commandCalls(InvokeCommand)
    .map((c) =>
      JSON.parse(Buffer.from(c.args[0].input.Payload as Uint8Array).toString()),
    ) as RagIndexerWorkerPayload[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rag-indexer-orchestrator', () => {
  beforeEach(() => {
    ddbMock.reset();
    lambdaMock.reset();
    vi.clearAllMocks();
  });

  it('does nothing when no RAG-enabled buckets exist', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('scans the enablement rows filtering on sk=RAG and status=active', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [enablementItem('bucket-1', 'org-1')] });
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    const scanInput = ddbMock.commandCalls(ScanCommand)[0].args[0].input;
    expect(scanInput.TableName).toBe('UserInfoTable');
    expect(scanInput.FilterExpression).toContain('sk = :sk');
    expect(scanInput.ExpressionAttributeValues).toMatchObject({
      ':sk': { S: 'RAG' },
      ':active': { S: 'active' },
    });
  });

  it('async-invokes the worker once per org (InvocationType Event)', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [enablementItem('bucket-1', 'org-1')] });
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.FunctionName).toBe('rag-indexer-worker-fn');
    expect(calls[0].args[0].input.InvocationType).toBe('Event');

    const payloads = payloadsFrom();
    expect(payloads[0].orgId).toBe('org-1');
    expect(payloads[0].buckets).toEqual([{ region: 'eu-west-1', bucketName: 'bucket-1' }]);
  });

  it('groups multiple buckets of one org into a single worker invocation', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [enablementItem('bucket-1', 'org-1'), enablementItem('bucket-2', 'org-1')],
    });
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
    expect(payloadsFrom()[0].buckets).toEqual([
      { region: 'eu-west-1', bucketName: 'bucket-1' },
      { region: 'eu-west-1', bucketName: 'bucket-2' },
    ]);
  });

  it('invokes one worker per distinct org', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [enablementItem('bucket-1', 'org-1'), enablementItem('bucket-2', 'org-2')],
    });
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    const payloads = payloadsFrom();
    expect(payloads).toHaveLength(2);
    expect(payloads.map((p) => p.orgId).sort()).toEqual(['org-1', 'org-2']);
  });

  it('handles a paginated scan', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [enablementItem('bucket-1', 'org-1')],
        LastEvaluatedKey: marshall({ pk: 'BUCKET#org-1#eu-west-1#bucket-1', sk: 'RAG' }),
      })
      .resolvesOnce({ Items: [enablementItem('bucket-2', 'org-2')] });
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(2);
  });

  it('skips enablement rows missing an orgId', async () => {
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [enablementItem('bucket-1', 'org-1', { orgId: undefined })] });
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('skips enablement rows whose bucket pk is unparseable (unknown region)', async () => {
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [enablementItem('bucket-1', 'org-1', {}, 'mars-1')] });
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('carries the bucket region through to the worker payload', async () => {
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [enablementItem('bucket-2', 'org-2', {}, 'us-east-1')] });
    lambdaMock.on(InvokeCommand).resolves({});

    await handler();

    expect(payloadsFrom()[0].buckets).toEqual([{ region: 'us-east-1', bucketName: 'bucket-2' }]);
  });

  it('continues when one org worker invoke fails (per-org isolation)', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [enablementItem('bucket-1', 'org-1'), enablementItem('bucket-2', 'org-2')],
    });
    lambdaMock.on(InvokeCommand).rejectsOnce(new Error('invoke failed')).resolves({});

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(2);
  });
});
