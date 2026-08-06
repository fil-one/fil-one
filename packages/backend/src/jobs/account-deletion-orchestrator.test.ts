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

import { handler } from './account-deletion-orchestrator.js';

function deletionRecord(orgId: string, overrides?: Record<string, unknown>) {
  const item: Record<string, unknown> = {
    pk: `ORG#${orgId}`,
    sk: 'DELETION',
    status: 'PENDING',
    attemptCount: 1,
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h — past the 60min window
    members: [],
    requestedAt: '2026-07-10T00:00:00.000Z',
    requestedByUserId: 'user-1',
    ...overrides,
  };
  // An `undefined` override means "absent from the record".
  for (const key of Object.keys(item)) {
    if (item[key] === undefined) delete item[key];
  }
  return marshall(item);
}

describe('account-deletion-orchestrator', () => {
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

  it('leaves a record inside the 60-minute window alone: the worker (900s timeout) may still be running', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        deletionRecord('org-1', {
          updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30min
        }),
      ],
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

  it('excludes DONE and non-ORG records via the scan filter and projects only what it reads', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler();

    const scan = ddbMock.commandCalls(ScanCommand)[0].args[0].input;
    expect(scan.FilterExpression).toBe(
      'begins_with(pk, :orgPrefix) AND sk = :deletion AND #s <> :done',
    );
    expect(scan.ExpressionAttributeValues?.[':orgPrefix']).toEqual({ S: 'ORG#' });
    expect(scan.ExpressionAttributeValues?.[':done']).toEqual({ S: 'DONE' });
    expect(scan.ProjectionExpression).toBe('pk, updatedAt, attemptCount');
  });

  it('pages the scan via LastEvaluatedKey and reconciles records from every page', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [deletionRecord('org-1')],
        LastEvaluatedKey: marshall({ pk: 'ORG#org-1', sk: 'DELETION' }),
      })
      .resolves({ Items: [deletionRecord('org-2')] });

    await handler();

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    const orgIds = lambdaMock.commandCalls(InvokeCommand).map(
      (c) =>
        (
          JSON.parse(new TextDecoder().decode(c.args[0].input.Payload as Uint8Array)) as {
            orgId: string;
          }
        ).orgId,
    );
    expect(orgIds).toEqual(['org-1', 'org-2']);
  });

  it('a failed scan propagates: no re-invokes and (by design) no stuck gauge this run', async () => {
    ddbMock.on(ScanCommand).rejects(new Error('DynamoDB unavailable'));

    await expect(handler()).rejects.toThrow('DynamoDB unavailable');

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
    expect(reportMetricMock).not.toHaveBeenCalled();
  });

  it('treats a record with a garbled or missing updatedAt as stale so it still gets re-driven', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        deletionRecord('org-garbled', { updatedAt: 'not-a-timestamp' }),
        deletionRecord('org-missing', { updatedAt: undefined }),
      ],
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await handler();

      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unparseable updatedAt'),
        expect.objectContaining({ pk: 'ORG#org-garbled' }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('emits the stuck gauge even when every re-invoke fails', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [deletionRecord('org-1', { attemptCount: 5 })],
    });
    lambdaMock.on(InvokeCommand).rejects(new Error('throttled'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handler();

      const emitted = reportMetricMock.mock.calls
        .map(([e]) => e as MetricEvent)
        .find((e) => 'StuckAccountDeletionCount' in e);
      expect(emitted?.StuckAccountDeletionCount).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('still rescues legacy records carrying a pre-redesign intermediate status', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [deletionRecord('org-legacy', { status: 'TENANTS_DISABLED' })],
    });

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
  });

  it('logs actual re-invoke outcomes, counting failed invokes separately', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [deletionRecord('org-1'), deletionRecord('org-2')],
    });
    lambdaMock.on(InvokeCommand).rejectsOnce(new Error('throttled')).resolves({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handler();

      expect(logSpy).toHaveBeenCalledWith('[account-deletion-orchestrator] Reconcile complete', {
        incomplete: 2,
        stale: 2,
        reinvoked: 1,
        failed: 1,
        stuck: 0,
      });
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
