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

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR_MS).toISOString();

/** Stale by default: `updatedAt` an hour back is past the 30-minute cutoff. */
function pending(
  orgId: string,
  { attempts = 1, updatedAt = hoursAgo(1), requestedAt = hoursAgo(1) } = {},
) {
  return marshall({ pk: `ORG#${orgId}`, attempts, updatedAt, requestedAt });
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

  // The scan takes every unfinished record, because the age gauge measures all of
  // them; the staleness cutoff then decides which get re-driven.
  it('scans every unfinished deletion', async () => {
    await handler();

    const input = ddbMock.commandCalls(ScanCommand)[0]!.args[0].input;
    expect(input.FilterExpression).toBe('sk = :sk AND #status <> :done');
    expect(input.ExpressionAttributeValues![':done']).toEqual({ S: 'DONE' });
  });

  // 30 minutes is double the worker's 15-minute ceiling, so at most one sweeper
  // invoke can overlap a live pass.
  it('leaves a deletion that is still progressing alone', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [pending('org-live', { updatedAt: new Date(Date.now() - 60_000).toISOString() })],
    });

    await handler();

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(metricNamed('StuckAccountDeletionCount')[0]!.StuckAccountDeletionCount).toBe(0);
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

  describe('the oldest pending age', () => {
    // Measures a different thing from staleness: a teardown can bump updatedAt
    // every pass and still never finish.
    it('reports the age of the oldest unfinished deletion, stale or not', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          pending('org-young', { requestedAt: hoursAgo(2) }),
          pending('org-old', { requestedAt: hoursAgo(200), updatedAt: new Date().toISOString() }),
        ],
      });

      await handler();

      const age = metricNamed('OldestPendingDeletionAgeHours')[0]!
        .OldestPendingDeletionAgeHours as number;
      expect(age).toBeGreaterThanOrEqual(200);
      expect(age).toBeLessThan(201);
    });

    // Emitted at zero so a Grafana alert above 168 hours auto-clears.
    it('reports zero when nothing is pending', async () => {
      await handler();

      expect(metricNamed('OldestPendingDeletionAgeHours')[0]!.OldestPendingDeletionAgeHours).toBe(
        0,
      );
    });
  });

  describe('blocked records', () => {
    // Past this many passes a teardown is not retrying, it is stuck on something
    // only an operator can clear.
    it('flags one past the attempt threshold, with the orgId only in the log', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [pending('org-blocked', { attempts: 11 })] });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await handler();
        const blocked = metricNamed('BlockedAccountDeletion');
        expect(blocked).toHaveLength(1);
        // No dimension: an orgId one is unbounded cardinality in the metric stream.
        expect(blocked[0]!._aws.CloudWatchMetrics[0]!.Dimensions).toEqual([[]]);
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining('blocked'),
          expect.objectContaining({ orgId: 'org-blocked' }),
        );
      } finally {
        error.mockRestore();
      }
    });

    it('does not flag one still within its retry budget', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [pending('org-1', { attempts: 10 })] });

      await handler();

      expect(metricNamed('BlockedAccountDeletion')).toHaveLength(0);
    });

    // Being blocked does not stop the re-drive: the next pass may be the one that
    // gets through.
    it('still re-drives a blocked record', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [pending('org-blocked', { attempts: 99 })] });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await handler();
        expect(mockInvoke).toHaveBeenCalledWith('org-blocked');
      } finally {
        error.mockRestore();
      }
    });
  });
});
