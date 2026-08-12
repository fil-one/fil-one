import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { reportMetric, type MetricEvent } from '../lib/metrics.js';

vi.mock('sst', () => ({ Resource: { UserInfoTable: { name: 'UserInfoTable' } } }));
vi.mock('../lib/metrics.js', () => ({ reportMetric: vi.fn() }));

const mockInvoke = vi.fn(async (_orgId: string) => undefined);
vi.mock('../lib/account-deletion-invoke.js', () => ({
  invokeAccountDeletionWorker: (orgId: string) => mockInvoke(orgId),
}));

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './account-deletion-sweeper.js';

const reportMetricMock = vi.mocked(reportMetric);
const metrics = (): MetricEvent[] => reportMetricMock.mock.calls.map(([e]) => e);
const metricNamed = (name: string) => metrics().filter((e) => e[name] !== undefined);

function pending(orgId: string, attempts = 1) {
  return marshall({ pk: `ORG#${orgId}`, attempts });
}

describe('account-deletion-sweeper', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    ddbMock.on(ScanCommand).resolves({ Items: [] });
  });

  it('re-drives every stuck deletion', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [pending('org-1'), pending('org-2')] });

    await handler();

    expect(mockInvoke).toHaveBeenCalledWith('org-1');
    expect(mockInvoke).toHaveBeenCalledWith('org-2');
  });

  // 30 minutes is double the worker's 15-minute ceiling, so at most one sweeper
  // invoke can overlap a live pass.
  it('only looks at unfinished records older than the stale cutoff', async () => {
    const before = Date.now();

    await handler();

    const input = ddbMock.commandCalls(ScanCommand)[0]!.args[0].input;
    expect(input.FilterExpression).toBe('sk = :sk AND #status <> :done AND updatedAt < :cutoff');
    expect(input.ExpressionAttributeValues![':done']).toEqual({ S: 'DONE' });

    const cutoff = new Date(input.ExpressionAttributeValues![':cutoff']!.S!).getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(before - cutoff).toBeLessThan(31 * 60 * 1000);
  });

  it('does nothing when no deletion is stuck', async () => {
    await handler();

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(metricNamed('StuckAccountDeletionCount')[0]!.StuckAccountDeletionCount).toBe(0);
  });

  it('pages the scan, threading the cursor back through', async () => {
    const cursor = marshall({ pk: 'ORG#org-1', sk: 'DELETION' });
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({ Items: [pending('org-1')], LastEvaluatedKey: cursor })
      .resolves({ Items: [pending('org-2')] });

    await handler();

    const calls = ddbMock.commandCalls(ScanCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args[0].input.ExclusiveStartKey).toEqual(cursor);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('reports how many are stuck', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [pending('org-1'), pending('org-2')] });

    await handler();

    expect(metricNamed('StuckAccountDeletionCount')[0]!.StuckAccountDeletionCount).toBe(2);
  });

  describe('wedged records', () => {
    // Past this many passes a teardown is not retrying, it is stuck on something
    // only an operator can clear.
    it('flags one past the attempt threshold, carrying the orgId', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [pending('org-wedged', 11)] });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await handler();
        const wedged = metricNamed('WedgedAccountDeletion');
        expect(wedged).toHaveLength(1);
        expect(wedged[0]!.orgId).toBe('org-wedged');
        expect(error).toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    });

    it('does not flag one still within its retry budget', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [pending('org-1', 10)] });

      await handler();

      expect(metricNamed('WedgedAccountDeletion')).toHaveLength(0);
    });

    // Being wedged does not stop the re-drive: the next pass may be the one that
    // gets through.
    it('still re-drives a wedged record', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [pending('org-wedged', 99)] });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await handler();
        expect(mockInvoke).toHaveBeenCalledWith('org-wedged');
      } finally {
        error.mockRestore();
      }
    });
  });
});
