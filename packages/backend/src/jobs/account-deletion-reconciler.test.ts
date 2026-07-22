import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import { type MetricEvent, reportMetric } from '../lib/metrics.js';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

vi.mock('../lib/metrics.js', () => ({
  reportMetric: vi.fn(),
}));

const reportMetricMock = vi.mocked(reportMetric);
const ddbMock = mockClient(DynamoDBClient);
const lambdaMock = mockClient(LambdaClient);

process.env.ACCOUNT_DELETION_WORKER_FUNCTION_NAME = 'account-deletion-worker';

import { handler } from './account-deletion-reconciler.js';

function deletionRecord(orgId: string, overrides?: Record<string, unknown>) {
  return marshall({
    pk: `ORG#${orgId}`,
    sk: 'DELETION',
    status: 'TENANTS_DISABLED',
    attemptCount: 1,
    updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h stale
    members: [],
    requestedAt: '2026-07-10T00:00:00.000Z',
    requestedByUserId: 'user-1',
    ...overrides,
  });
}

describe('account-deletion-reconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    lambdaMock.reset();
    lambdaMock.on(InvokeCommand).resolves({});
  });

  it('re-invokes the worker for stale incomplete deletions', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [deletionRecord('org-1')] });

    await handler();

    const invoke = lambdaMock.commandCalls(InvokeCommand)[0].args[0].input;
    expect(invoke.FunctionName).toBe('account-deletion-worker');
    expect(JSON.parse(new TextDecoder().decode(invoke.Payload as Uint8Array))).toEqual({
      orgId: 'org-1',
    });
  });

  it('leaves recently-active records alone', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [deletionRecord('org-1', { updatedAt: new Date().toISOString() })],
    });

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('emits StuckAccountDeletionCount for records past the attempt threshold', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        deletionRecord('org-1', { attemptCount: 5 }),
        deletionRecord('org-2', { attemptCount: 1 }),
      ],
    });

    await handler();

    const emitted = reportMetricMock.mock.calls
      .map(([e]) => e as MetricEvent)
      .find((e) => 'StuckAccountDeletionCount' in e);
    expect(emitted?.StuckAccountDeletionCount).toBe(1);
  });

  it('excludes DONE records via the scan filter', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler();

    const scan = ddbMock.commandCalls(ScanCommand)[0].args[0].input;
    expect(scan.FilterExpression).toBe('sk = :deletion AND #s <> :done');
    expect(scan.ExpressionAttributeValues?.[':done']).toEqual({ S: 'DONE' });
  });
});
