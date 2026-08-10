import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BatchGetItemCommand,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import { type MetricEvent, reportMetric } from '../lib/metrics.js';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
    RagIndexerTable: { name: 'RagIndexerTable' },
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

/** A DONE deletion record — the shape the resurrection sweep reads. */
function doneRecord(orgId: string, overrides?: Record<string, unknown>) {
  return deletionRecord(orgId, {
    status: 'DONE',
    members: [{ userId: `user-${orgId}` }],
    ...overrides,
  });
}

/** An `ORG#{orgId}/PROFILE` row still carrying fence B. */
function fencedProfile(orgId: string) {
  return marshall({ pk: `ORG#${orgId}`, sk: 'PROFILE', deleting: true });
}

/** A `RAGKEYHASH#{hash}/LOOKUP` row naming an org. */
function ragKeyHashRow(orgId: string) {
  return marshall({ pk: `RAGKEYHASH#hash-${orgId}`, sk: 'LOOKUP', orgId });
}

/** The org partition as a completed teardown leaves it: only the audit record. */
const PURGED_PARTITION = { Items: [marshall({ sk: 'DELETION' })] };

function scanReturns(items: Record<string, AttributeValue>[]) {
  ddbMock.on(ScanCommand, { TableName: 'UserInfoTable' }).resolves({ Items: items });
}

function invokedPayloads(): { orgId: string; resweep?: boolean }[] {
  return lambdaMock.commandCalls(InvokeCommand).map(
    (c) =>
      JSON.parse(new TextDecoder().decode(c.args[0].input.Payload as Uint8Array)) as {
        orgId: string;
        resweep?: boolean;
      },
  );
}

function gauge(name: string): number | undefined {
  const emitted = reportMetricMock.mock.calls.map(([e]) => e as MetricEvent).find((e) => name in e);
  return emitted?.[name] as number | undefined;
}

describe('account-deletion-orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    lambdaMock.reset();
    lambdaMock.on(InvokeCommand).resolves({});
    ddbMock.on(BatchGetItemCommand).resolves({ Responses: { BillingTable: [] } });
    ddbMock.on(ScanCommand, { TableName: 'RagIndexerTable' }).resolves({ Items: [] });
    ddbMock.on(QueryCommand).resolves(PURGED_PARTITION);
    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    scanReturns([]);
  });

  it('re-invokes the worker for stale incomplete deletions', async () => {
    scanReturns([deletionRecord('org-1')]);

    await handler();

    const invoke = lambdaMock.commandCalls(InvokeCommand)[0].args[0].input;
    expect(invoke.FunctionName).toBe('account-deletion-worker');
    // No `resweep`: this record is not DONE, so nothing needs to bypass the
    // DONE early-return in runAccountDeletion.
    expect(invokedPayloads()).toEqual([{ orgId: 'org-1' }]);
  });

  it('leaves recently-active records alone', async () => {
    scanReturns([deletionRecord('org-1', { updatedAt: new Date().toISOString() })]);

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('leaves a record inside the 60-minute window alone: the worker (900s timeout) may still be running', async () => {
    scanReturns([
      deletionRecord('org-1', {
        updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30min
      }),
    ]);

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('emits StuckAccountDeletionCount for records past the attempt threshold', async () => {
    scanReturns([
      deletionRecord('org-1', { attemptCount: 5 }),
      deletionRecord('org-2', { attemptCount: 1 }),
    ]);

    await handler();

    expect(gauge('StuckAccountDeletionCount')).toBe(1);
  });

  it('scan filter returns DELETION records, fenced ORG profiles and RAGKEYHASH lookups, and projects only what it reads', async () => {
    await handler();

    const scan = ddbMock
      .commandCalls(ScanCommand)
      .map((c) => c.args[0].input)
      .find((input) => input.TableName === 'UserInfoTable')!;
    expect(scan.FilterExpression).toBe(
      '(begins_with(pk, :orgPrefix) AND (sk = :deletion OR (sk = :profile AND deleting = :true)))' +
        ' OR (begins_with(pk, :hashPrefix) AND sk = :lookup)',
    );
    expect(scan.ExpressionAttributeValues).toEqual({
      ':orgPrefix': { S: 'ORG#' },
      ':deletion': { S: 'DELETION' },
      ':profile': { S: 'PROFILE' },
      ':true': { BOOL: true },
      ':hashPrefix': { S: 'RAGKEYHASH#' },
      ':lookup': { S: 'LOOKUP' },
    });
    expect(scan.ProjectionExpression).toBe(
      'pk, sk, updatedAt, attemptCount, #s, #m, orgId, ' +
        'resurrectedStripeCustomerIds, stripeRedactionJobStatuses',
    );
    expect(scan.ExpressionAttributeNames).toEqual({ '#s': 'status', '#m': 'members' });
  });

  it('pages the scan via LastEvaluatedKey and reconciles records from every page', async () => {
    ddbMock
      .on(ScanCommand, { TableName: 'UserInfoTable' })
      .resolvesOnce({
        Items: [deletionRecord('org-1')],
        LastEvaluatedKey: marshall({ pk: 'ORG#org-1', sk: 'DELETION' }),
      })
      .resolves({ Items: [deletionRecord('org-2')] });

    await handler();

    expect(invokedPayloads().map((p) => p.orgId)).toEqual(['org-1', 'org-2']);
  });

  it('a failed scan propagates: no re-invokes and (by design) no stuck gauge this run', async () => {
    ddbMock
      .on(ScanCommand, { TableName: 'UserInfoTable' })
      .rejects(new Error('DynamoDB unavailable'));

    await expect(handler()).rejects.toThrow('DynamoDB unavailable');

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
    expect(reportMetricMock).not.toHaveBeenCalled();
  });

  it('treats a record with a garbled or missing updatedAt as stale so it still gets re-driven', async () => {
    scanReturns([
      deletionRecord('org-garbled', { updatedAt: 'not-a-timestamp' }),
      deletionRecord('org-missing', { updatedAt: undefined }),
    ]);
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
    scanReturns([deletionRecord('org-1', { attemptCount: 5 })]);
    lambdaMock.on(InvokeCommand).rejects(new Error('throttled'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handler();

      expect(gauge('StuckAccountDeletionCount')).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('still rescues legacy records carrying a pre-redesign intermediate status', async () => {
    scanReturns([deletionRecord('org-legacy', { status: 'TENANTS_DISABLED' })]);

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
  });

  it('logs actual outcomes, counting failed invokes and each re-drive kind separately', async () => {
    scanReturns([deletionRecord('org-1'), deletionRecord('org-2'), doneRecord('org-done')]);
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
        swept: 1,
        sweepSkipped: 0,
        ragIndexTruncated: false,
        fenceSkipped: 0,
        resurrected: 0,
        reswept: 0,
        resweepFailed: 0,
        redactionFailed: 0,
        unwedged: 0,
      });
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  describe('rescue path ordering (M7)', () => {
    it('emits the stuck gauge and re-drives stale records BEFORE the sweep touches the table', async () => {
      scanReturns([deletionRecord('org-stale', { attemptCount: 5 }), doneRecord('org-done')]);
      const order: string[] = [];
      reportMetricMock.mockImplementation((event) => {
        order.push(Object.keys(event).filter((k) => k.endsWith('Count'))[0]);
      });
      lambdaMock.on(InvokeCommand).callsFake(() => {
        order.push('invoke');
        return {};
      });
      ddbMock.on(QueryCommand).callsFake(() => {
        order.push('sweep');
        return PURGED_PARTITION;
      });

      await handler();

      // The rescue path (gauge, then re-drive) comes first; the sweep and its
      // own gauges follow. Later entries are the budget/failure gauges added
      // for alerting, which are emitted after the work they describe.
      expect(order.slice(0, 4)).toEqual([
        'StuckAccountDeletionCount',
        'invoke',
        'sweep',
        'ResurrectedAccountDeletionCount',
      ]);
    });
  });

  describe('resurrection sweep', () => {
    it('does not re-invoke a DONE record whose every surface is clean', async () => {
      scanReturns([doneRecord('org-done')]);

      await handler();

      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
      expect(gauge('ResurrectedAccountDeletionCount')).toBe(0);
    });

    it('warns and re-invokes WITH resweep for a DONE record with a surviving member billing row', async () => {
      scanReturns([doneRecord('org-resurrected')]);
      ddbMock.on(BatchGetItemCommand).resolves({
        Responses: {
          BillingTable: [marshall({ pk: 'CUSTOMER#user-org-resurrected', sk: 'SUBSCRIPTION' })],
        },
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await handler();

        // `resweep: true` is the whole point — without it runAccountDeletion
        // returns immediately on the DONE record and nothing is ever deleted.
        expect(invokedPayloads()).toEqual([{ orgId: 'org-resurrected', resweep: true }]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Residue found after a completed teardown'),
          expect.objectContaining({
            orgId: 'org-resurrected',
            surfaces: ['billing'],
            userIds: ['user-org-resurrected'],
          }),
        );
        expect(gauge('ResurrectedAccountDeletionCount')).toBe(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('re-invokes both a stale non-DONE record and a resurrected DONE record from a mixed scan', async () => {
      scanReturns([deletionRecord('org-stale'), doneRecord('org-resurrected')]);
      ddbMock.on(BatchGetItemCommand).resolves({
        Responses: {
          BillingTable: [marshall({ pk: 'CUSTOMER#user-org-resurrected', sk: 'SUBSCRIPTION' })],
        },
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await handler();

        expect(invokedPayloads()).toEqual([
          { orgId: 'org-stale' },
          { orgId: 'org-resurrected', resweep: true },
        ]);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('does not batch-get anything for a DONE record with empty or missing members', async () => {
      scanReturns([
        doneRecord('org-empty', { members: [] }),
        doneRecord('org-missing', { members: undefined }),
      ]);

      await handler();

      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(BatchGetItemCommand)).toHaveLength(0);
    });

    it('re-drives a DONE org whose RAGKEYHASH# lookup row outlived the purge', async () => {
      scanReturns([doneRecord('org-done'), ragKeyHashRow('org-done')]);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await handler();

        expect(invokedPayloads()).toEqual([{ orgId: 'org-done', resweep: true }]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Residue found after a completed teardown'),
          expect.objectContaining({ surfaces: ['ragKeyHash'] }),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    // A resweep holds its Stripe failure so the DynamoDB purge can run, which
    // deletes the rows every OTHER surface detects the org by. From the next
    // run on the org looks spotless, the record is DONE (so the stale re-drive
    // never sees it either), and past Lambda's two bounded async retries
    // nothing would ever POST /run again — the resurrected customer's PII would
    // sit in Stripe forever. The record's own redaction state is the only thing
    // that survives its purge, so it is what the re-drive keys on.
    describe('the Stripe tail a resweep cannot purge', () => {
      it('re-drives a DONE org whose resurrected customer has no terminal redaction status, with every data surface clean', async () => {
        scanReturns([doneRecord('org-x', { resurrectedStripeCustomerIds: ['cus_resurrected'] })]);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
          await handler();

          expect(invokedPayloads()).toEqual([{ orgId: 'org-x', resweep: true }]);
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Residue found after a completed teardown'),
            expect.objectContaining({
              orgId: 'org-x',
              surfaces: ['stripeRedaction'],
              pendingRedactionCustomerIds: ['cus_resurrected'],
            }),
          );
          expect(gauge('ResurrectedAccountDeletionCount')).toBe(1);
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('stops re-driving once every resurrected customer reaches a terminal status', async () => {
        scanReturns([
          doneRecord('org-x', {
            resurrectedStripeCustomerIds: ['cus_a', 'cus_b'],
            stripeRedactionJobStatuses: { cus_a: 'redacting', cus_b: 'succeeded' },
          }),
        ]);

        await handler();

        expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
        expect(gauge('ResurrectedAccountDeletionCount')).toBe(0);
      });

      it('keeps re-driving while ONE of several customers is still outstanding', async () => {
        scanReturns([
          doneRecord('org-x', {
            resurrectedStripeCustomerIds: ['cus_a', 'cus_b'],
            stripeRedactionJobStatuses: { cus_a: 'succeeded' },
          }),
        ]);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
          await handler();

          expect(invokedPayloads()).toEqual([{ orgId: 'org-x', resweep: true }]);
          expect(warnSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ pendingRedactionCustomerIds: ['cus_b'] }),
          );
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('an outstanding redaction outlives the 7-day window, unlike a row surface', async () => {
        // The window bounds the hunt for resurrected ROWS. Ageing out a known,
        // finite erasure obligation would abandon the customer's PII.
        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
        scanReturns([
          doneRecord('org-old', {
            updatedAt: eightDaysAgo,
            resurrectedStripeCustomerIds: ['cus_resurrected'],
          }),
        ]);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
          await handler();

          expect(invokedPayloads()).toEqual([{ orgId: 'org-old', resweep: true }]);
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('a terminally-FAILED redaction stops the loop and is surfaced on its own gauge instead', async () => {
        // Terminal is what makes the re-drive converge, so nothing downstream
        // will look at this org again — the gauge and the error line are all
        // that stand between the operator and un-erased PII.
        scanReturns([
          doneRecord('org-x', {
            resurrectedStripeCustomerIds: ['cus_resurrected'],
            stripeRedactionJobStatuses: { cus_resurrected: 'failed' },
          }),
        ]);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
          await handler();

          expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
          expect(gauge('DeletionRedactionFailedCount')).toBe(1);
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('was left un-redacted'),
            expect.objectContaining({ orgId: 'org-x', customerIds: ['cus_resurrected'] }),
          );
        } finally {
          errorSpy.mockRestore();
        }
      });

      it('counts a failed redaction even on a record far outside the sweep window', async () => {
        // Otherwise the alarm quietly ages out while the PII is still there.
        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
        scanReturns([
          doneRecord('org-old', {
            updatedAt: eightDaysAgo,
            resurrectedStripeCustomerIds: ['cus_resurrected'],
            stripeRedactionJobStatuses: { cus_resurrected: 'canceled' },
          }),
        ]);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
          await handler();

          expect(gauge('DeletionRedactionFailedCount')).toBe(1);
          expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
        } finally {
          errorSpy.mockRestore();
        }
      });

      it('emits a zero gauge on an ordinary run, so an absent datapoint stays distinguishable', async () => {
        scanReturns([doneRecord('org-done')]);

        await handler();

        expect(gauge('DeletionRedactionFailedCount')).toBe(0);
      });

      it('dedupes an id an overlapping resweep appended twice', async () => {
        // `resurrectedStripeCustomerIds` is list_append-ed, so it can repeat.
        scanReturns([doneRecord('org-x', { resurrectedStripeCustomerIds: ['cus_a', 'cus_a'] })]);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
          await handler();

          expect(warnSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ pendingRedactionCustomerIds: ['cus_a'] }),
          );
        } finally {
          warnSpy.mockRestore();
        }
      });
    });

    it('bounds the sweep to recently-DONE records: an old one is neither probed nor re-driven', async () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      scanReturns([doneRecord('org-old', { updatedAt: eightDaysAgo })]);
      ddbMock.on(BatchGetItemCommand).resolves({
        Responses: {
          BillingTable: [marshall({ pk: 'CUSTOMER#user-org-old', sk: 'SUBSCRIPTION' })],
        },
      });

      await handler();

      expect(ddbMock.commandCalls(BatchGetItemCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
    });
  });

  describe('deletion-fence unwedge', () => {
    /** The transactions that carry an unwedge, as `{ ConditionCheck?, Update? }` pairs. */
    function unwedgeTransactions() {
      return ddbMock
        .commandCalls(TransactWriteItemsCommand)
        .map((c) => c.args[0].input.TransactItems ?? [])
        .filter((items) => items.some((i) => i.Update?.UpdateExpression === 'REMOVE deleting'));
    }

    /** Just the `Update` half, for the assertions that only care about the write. */
    function unwedgeCalls() {
      return unwedgeTransactions().map((items) => items.find((i) => i.Update)!.Update!);
    }

    it('clears an orphaned fence with REMOVE (never `SET deleting = false`) and warns', async () => {
      // REMOVE is load-bearing: lib/orchestrator/tenant-setup.ts,
      // lib/fth/fth-tenant-setup.ts and lib/aurora/aurora-tenant-setup.ts all
      // condition their tenant-id write on `attribute_not_exists(deleting)`,
      // so a literal `false` would leave tenant setup refused forever.
      scanReturns([fencedProfile('org-wedged')]);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await handler();

        expect(unwedgeCalls()).toHaveLength(1);
        expect(unwedgeCalls()[0]).toMatchObject({
          TableName: 'UserInfoTable',
          Key: marshall({ pk: 'ORG#org-wedged', sk: 'PROFILE' }),
          ConditionExpression: 'attribute_exists(pk) AND deleting = :true',
        });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Cleared an orphaned deletion fence'),
          { orgId: 'org-wedged' },
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('asserts the DELETION record is absent IN THE SAME transaction as the clear', async () => {
      // A check-then-write cannot close this race: a teardown starting between
      // the read and the write sets `deleting = true` on an org that was
      // ALREADY fenced, so `deleting = :true` still holds and the clear
      // succeeds against a live deletion. Absence of the record is the real
      // claim, so it is asserted atomically alongside the write.
      scanReturns([fencedProfile('org-wedged')]);

      await handler();

      const check = unwedgeTransactions()[0].find((item) => item.ConditionCheck)!.ConditionCheck!;
      expect(check).toMatchObject({
        TableName: 'UserInfoTable',
        Key: marshall({ pk: 'ORG#org-wedged', sk: 'DELETION' }),
        ConditionExpression: 'attribute_not_exists(pk)',
      });
    });

    it('leaves the fence alone while a teardown is genuinely in flight', async () => {
      scanReturns([fencedProfile('org-deleting'), deletionRecord('org-deleting')]);

      await handler();

      expect(unwedgeCalls()).toHaveLength(0);
    });

    it('does not clear when a deletion the scan had not caught up to exists', async () => {
      // The scan is eventually consistent, and un-fencing a live deletion is
      // the expensive mistake — so "no record in the scan" is never trusted:
      // the transaction's ConditionCheck is what confirms it, and DynamoDB
      // cancels the whole thing when the record turns out to exist.
      scanReturns([fencedProfile('org-racing')]);
      ddbMock.on(TransactWriteItemsCommand).rejects(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        }),
      );
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await handler();

        expect(logSpy).toHaveBeenCalledWith(
          '[account-deletion-orchestrator] Reconcile complete',
          expect.objectContaining({ unwedged: 0 }),
        );
      } finally {
        logSpy.mockRestore();
      }
    });

    it('a transaction cancelled for a TRANSIENT reason is an error, not a declined unwedge', async () => {
      // Throttling and TransactionConflict also cancel a transaction. Reading
      // them as "declined" would silently drop the unwedge and report success.
      scanReturns([fencedProfile('org-wedged')]);
      ddbMock.on(TransactWriteItemsCommand).rejects(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }],
        }),
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await handler();

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Failed to reconcile a deletion fence'),
          expect.objectContaining({ orgId: 'org-wedged' }),
        );
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('re-drives a DONE org whose profile survived instead of un-fencing it', async () => {
      // A DONE record means the org IS deleted, so a surviving profile is
      // unpurged data — clearing the fence would re-open every fenced writer
      // on an account the user was told is gone.
      scanReturns([fencedProfile('org-done'), doneRecord('org-done')]);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await handler();

        expect(unwedgeCalls()).toHaveLength(0);
        expect(invokedPayloads()).toEqual([{ orgId: 'org-done', resweep: true }]);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('does not double-invoke an org the sweep already found', async () => {
      scanReturns([fencedProfile('org-done'), doneRecord('org-done')]);
      ddbMock.on(QueryCommand).resolves({ Items: [marshall({ sk: 'PROFILE' })] });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await handler();

        expect(invokedPayloads()).toEqual([{ orgId: 'org-done', resweep: true }]);
        expect(gauge('ResurrectedAccountDeletionCount')).toBe(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('a failing fence reconcile is logged and does not abort the run', async () => {
      scanReturns([fencedProfile('org-wedged'), deletionRecord('org-stale')]);
      ddbMock.on(TransactWriteItemsCommand).rejects(new Error('DynamoDB unavailable'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await handler();

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Failed to reconcile a deletion fence'),
          expect.objectContaining({ orgId: 'org-wedged' }),
        );
        expect(invokedPayloads()).toEqual([{ orgId: 'org-stale' }]);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('does not count a clear that lost the conditional race', async () => {
      scanReturns([fencedProfile('org-wedged')]);
      const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
      ddbMock
        .on(TransactWriteItemsCommand)
        .rejects(new ConditionalCheckFailedException({ message: 'nope', $metadata: {} }));
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await handler();

        expect(logSpy).toHaveBeenCalledWith(
          '[account-deletion-orchestrator] Reconcile complete',
          expect.objectContaining({ unwedged: 0 }),
        );
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});
