import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: { BillingTable: { name: 'BillingTable' } },
}));

const ddbMock = mockClient(DynamoDBClient);

import {
  preferOrgRows,
  readSubscription,
  scanSubscriptions,
  scannedSubscription,
  SubscriptionKeys,
  updateSubscription,
  updateSubscriptionByUser,
  writeSubscription,
} from './subscription-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ID = 'org-1';
const USER_ID = 'user-1';
const ORG_KEY = { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'SUBSCRIPTION' } };
const LEGACY_KEY = { pk: { S: `CUSTOMER#${USER_ID}` }, sk: { S: 'SUBSCRIPTION' } };

function row(fields: Parameters<typeof marshall>[0]) {
  return { Item: marshall(fields, { removeUndefinedValues: true }) };
}

/** What DynamoDB throws when a write's `ConditionExpression` is not satisfied. */
function conditionFailed(): Error {
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
  });
}

/** The same refusal, reported one level down in a transaction's cancellation reasons. */
function transactionConditionFailed(): Error {
  return Object.assign(new Error('Transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
  });
}

const SET_STATUS = {
  UpdateExpression: 'SET subscriptionStatus = :status',
  ExpressionAttributeValues: { ':status': { S: 'active' } },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('readSubscription', () => {
  beforeEach(() => ddbMock.reset());

  it('answers from the org key, and asks both at once rather than in turn', async () => {
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves(row({ pk: `ORG#${ORG_ID}`, sk: 'SUBSCRIPTION', orgId: ORG_ID }))
      .on(GetItemCommand, { Key: LEGACY_KEY })
      .resolves(row({ pk: `CUSTOMER#${USER_ID}`, sk: 'SUBSCRIPTION', orgId: ORG_ID }));

    const stored = await readSubscription(ORG_ID, USER_ID);

    // The org row still wins; the fallback costs a parallel read rather than a
    // second round trip, which every gated handler was paying per request.
    expect(stored?.key).toBe('org');
    expect(stored?.record.orgId).toBe(ORG_ID);
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(2);
  });

  it('refuses a legacy row that names a different org', async () => {
    // Otherwise a member reachable from two orgs spends the wrong org's
    // subscription the moment invitations make that possible.
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({})
      .on(GetItemCommand, { Key: LEGACY_KEY })
      .resolves(row({ pk: `CUSTOMER#${USER_ID}`, sk: 'SUBSCRIPTION', orgId: 'org-somebody-else' }));

    expect(await readSubscription(ORG_ID, USER_ID)).toBeUndefined();
  });

  it('serves a legacy row that names no org at all', async () => {
    // Rows predating the attribute are this caller's own by construction.
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({})
      .on(GetItemCommand, { Key: LEGACY_KEY })
      .resolves(row({ pk: `CUSTOMER#${USER_ID}`, sk: 'SUBSCRIPTION' }));

    expect((await readSubscription(ORG_ID, USER_ID))?.key).toBe('legacy');
  });

  it('falls back to the caller’s legacy row for an account the backfill has not reached', async () => {
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({})
      .on(GetItemCommand, { Key: LEGACY_KEY })
      .resolves(row({ pk: `CUSTOMER#${USER_ID}`, sk: 'SUBSCRIPTION', orgId: ORG_ID }));

    const stored = await readSubscription(ORG_ID, USER_ID);

    expect(stored?.key).toBe('legacy');
  });

  it('reports absence when neither key holds a row', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    expect(await readSubscription(ORG_ID, USER_ID)).toBeUndefined();
  });

  it('carries the read options to both keys', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    await readSubscription(ORG_ID, USER_ID, { consistentRead: true, projectionExpression: 'pk' });

    for (const call of ddbMock.commandCalls(GetItemCommand)) {
      expect(call.args[0].input).toMatchObject({
        ConsistentRead: true,
        ProjectionExpression: 'pk',
      });
    }
  });
});

describe('updateSubscription', () => {
  beforeEach(() => ddbMock.reset());

  it('writes the org key first, guarded on the row already existing', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await updateSubscription({ orgId: ORG_ID, userId: USER_ID }, SET_STATUS);

    const calls = ddbMock.commandCalls(UpdateItemCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0].args[0].input).toStrictEqual({
      TableName: 'BillingTable',
      Key: ORG_KEY,
      ...SET_STATUS,
      ConditionExpression: 'attribute_exists(pk)',
    });
    expect(calls[1].args[0].input).toStrictEqual({
      TableName: 'BillingTable',
      Key: LEGACY_KEY,
      ...SET_STATUS,
      ConditionExpression: 'attribute_exists(pk)',
    });
    expect(result.orgRowWritten).toBe(true);
    expect(result.legacyRowWritten).toBe(true);
  });

  it('leaves the legacy write alone when there is no org twin yet', async () => {
    ddbMock
      .on(UpdateItemCommand, { Key: ORG_KEY })
      .rejects(conditionFailed())
      .on(UpdateItemCommand, { Key: LEGACY_KEY })
      .resolves({});

    const result = await updateSubscription({ orgId: ORG_ID, userId: USER_ID }, SET_STATUS);

    expect(result.orgRowWritten).toBe(false);
    expect(ddbMock.commandCalls(UpdateItemCommand, { Key: LEGACY_KEY })).toHaveLength(1);
  });

  it('stops before the legacy row when the org write fails for any other reason', async () => {
    // The org row is the one every read prefers, so it must never be the stale
    // half of a pair. Failing here leaves both rows where the retry finds them.
    ddbMock.on(UpdateItemCommand, { Key: ORG_KEY }).rejects(new Error('Throughput exceeded'));

    await expect(
      updateSubscription({ orgId: ORG_ID, userId: USER_ID }, SET_STATUS),
    ).rejects.toThrow('Throughput exceeded');
    expect(ddbMock.commandCalls(UpdateItemCommand, { Key: LEGACY_KEY })).toHaveLength(0);
  });

  it('lets a caller that writes a whole record create the org row', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await updateSubscription(
      { orgId: ORG_ID, userId: USER_ID },
      { ...SET_STATUS, createsOrgRow: true },
    );

    expect(
      ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input.ConditionExpression,
    ).toBeUndefined();
  });

  it('holds the org row to the caller’s condition as well as its own existence', async () => {
    // Otherwise a write the condition forbids would still reach the org row —
    // the one every read prefers — while the legacy row correctly refused it.
    ddbMock.on(UpdateItemCommand).resolves({});

    await updateSubscription(
      { orgId: ORG_ID, userId: USER_ID },
      { ...SET_STATUS, ConditionExpression: 'attribute_exists(stripeCustomerId)' },
    );

    const calls = ddbMock.commandCalls(UpdateItemCommand);
    for (const call of calls) {
      expect(call.args[0].input.ConditionExpression).toBe(
        'attribute_exists(pk) AND (attribute_exists(stripeCustomerId))',
      );
    }
  });

  it('raises a caller condition the org row refused instead of swallowing it', async () => {
    // Only "no org twin yet" is silent. A condition the record failed is a fact
    // about the record, and assuming the legacy row will fail the same way is
    // how the two rows diverge unnoticed.
    ddbMock.on(UpdateItemCommand).rejects(conditionFailed());

    await expect(
      updateSubscription(
        { orgId: ORG_ID, userId: USER_ID },
        { ...SET_STATUS, ConditionExpression: 'attribute_exists(stripeCustomerId)' },
      ),
    ).rejects.toThrow('The conditional request failed');
    expect(ddbMock.commandCalls(UpdateItemCommand, { Key: LEGACY_KEY })).toHaveLength(0);
  });

  it('reports a missing row per key for a caller that tolerates one', async () => {
    ddbMock
      .on(UpdateItemCommand, { Key: ORG_KEY })
      .rejects(conditionFailed())
      .on(UpdateItemCommand, { Key: LEGACY_KEY })
      .rejects(conditionFailed());

    const result = await updateSubscription(
      { orgId: ORG_ID, userId: USER_ID },
      { ...SET_STATUS, tolerateMissingRow: true },
    );

    expect(result).toStrictEqual({
      previous: undefined,
      orgRowWritten: false,
      legacyRowWritten: false,
    });
  });

  it('still raises a missing legacy row for a caller that does not', async () => {
    ddbMock
      .on(UpdateItemCommand, { Key: ORG_KEY })
      .resolves({})
      .on(UpdateItemCommand, { Key: LEGACY_KEY })
      .rejects(conditionFailed());

    await expect(
      updateSubscription({ orgId: ORG_ID, userId: USER_ID }, SET_STATUS),
    ).rejects.toThrow('The conditional request failed');
  });

  it('returns the prior attributes of the row a read would have preferred', async () => {
    ddbMock
      .on(UpdateItemCommand, { Key: ORG_KEY })
      .resolves({ Attributes: { subscriptionStatus: { S: 'grace_period' } } })
      .on(UpdateItemCommand, { Key: LEGACY_KEY })
      .resolves({ Attributes: { subscriptionStatus: { S: 'stale' } } });

    const result = await updateSubscription(
      { orgId: ORG_ID, userId: USER_ID },
      { ...SET_STATUS, ReturnValues: 'ALL_OLD' },
    );

    expect(result.previous?.subscriptionStatus).toEqual({ S: 'grace_period' });
  });
});

describe('updateSubscriptionByUser', () => {
  beforeEach(() => ddbMock.reset());

  it('writes only the legacy key for a Stripe object that names no org', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await updateSubscriptionByUser({ userId: USER_ID }, SET_STATUS);

    const calls = ddbMock.commandCalls(UpdateItemCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Key).toStrictEqual(LEGACY_KEY);
    // One key is fewer writes, not weaker rules: still no upsert.
    expect(calls[0].args[0].input.ConditionExpression).toBe('attribute_exists(pk)');
    expect(result.orgRowWritten).toBe(false);
    expect(result.legacyRowWritten).toBe(true);
  });

  it('writes only the org key for a row that names no user', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await updateSubscriptionByUser({ orgId: ORG_ID }, SET_STATUS);

    const calls = ddbMock.commandCalls(UpdateItemCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Key).toStrictEqual(ORG_KEY);
  });

  it('refuses an update that names neither', async () => {
    await expect(updateSubscriptionByUser({}, SET_STATUS)).rejects.toThrow(
      'names neither an org nor a user',
    );
  });
});

describe('writeSubscription', () => {
  beforeEach(() => ddbMock.reset());

  const RECORD = {
    sk: { S: 'SUBSCRIPTION' },
    orgId: { S: ORG_ID },
    userId: { S: USER_ID },
    stripeCustomerId: { S: 'cus_1' },
  };

  it('creates both rows, each stamped with the org and the user', async () => {
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});

    await writeSubscription(
      { orgId: ORG_ID, userId: USER_ID },
      {
        item: { stripeCustomerId: { S: 'cus_1' } },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    );

    // The org row goes in a transaction with a check on the legacy key: the
    // caller's "no record" read can be true of one key and false of the other,
    // and a status-less org row would then shadow a complete legacy one.
    const [transact] = ddbMock.commandCalls(TransactWriteItemsCommand);
    expect(transact.args[0].input.TransactItems).toEqual([
      {
        Put: {
          TableName: 'BillingTable',
          Item: { ...RECORD, pk: { S: `ORG#${ORG_ID}` } },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        ConditionCheck: {
          TableName: 'BillingTable',
          Key: LEGACY_KEY,
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
    ]);

    const items = ddbMock.commandCalls(PutItemCommand).map((call) => call.args[0].input.Item);
    expect(items).toEqual([{ ...RECORD, pk: { S: `CUSTOMER#${USER_ID}` } }]);
  });

  it('leaves the org key alone when the legacy row is already there', async () => {
    // The account the backfill has not copied. Its legacy row is complete and
    // the org key stays empty until the backfill copies it whole.
    ddbMock.on(TransactWriteItemsCommand).rejects(transactionConditionFailed());
    ddbMock.on(PutItemCommand).resolves({});

    await writeSubscription(
      { orgId: ORG_ID, userId: USER_ID },
      {
        item: { stripeCustomerId: { S: 'cus_1' } },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    );

    const items = ddbMock.commandCalls(PutItemCommand).map((call) => call.args[0].input.Item);
    expect(items).toEqual([{ ...RECORD, pk: { S: `CUSTOMER#${USER_ID}` } }]);
  });

  it('lets the legacy row’s condition failure reach the caller', async () => {
    // Today's behavior: the caller decides what an existing record means.
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    ddbMock.on(PutItemCommand).rejects(conditionFailed());

    await expect(
      writeSubscription(
        { orgId: ORG_ID, userId: USER_ID },
        { item: {}, ConditionExpression: 'attribute_not_exists(pk)' },
      ),
    ).rejects.toThrow('The conditional request failed');
  });
});

describe('what the scanning jobs read off a row', () => {
  it('takes the user id from the row before the key', () => {
    expect(
      scannedSubscription({ pk: `ORG#${ORG_ID}`, orgId: ORG_ID, userId: USER_ID }),
    ).toStrictEqual({ pk: `ORG#${ORG_ID}`, orgId: ORG_ID, userId: USER_ID });
  });

  it('takes it from a legacy key when the row carries none', () => {
    expect(scannedSubscription({ pk: `CUSTOMER#${USER_ID}`, orgId: ORG_ID })).toStrictEqual({
      pk: `CUSTOMER#${USER_ID}`,
      orgId: ORG_ID,
      userId: USER_ID,
    });
  });

  it('names no user for an org row that carries none', () => {
    expect(scannedSubscription({ pk: `ORG#${ORG_ID}`, orgId: ORG_ID })).toStrictEqual({
      pk: `ORG#${ORG_ID}`,
      orgId: ORG_ID,
    });
  });

  it('reports a row with no orgId as unusable — the cohort every job skips', () => {
    expect(scannedSubscription({ pk: `CUSTOMER#${USER_ID}` })).toBeUndefined();
  });

  it('drops each legacy row whose org twin is in the same scan', () => {
    const rows = [
      { pk: 'CUSTOMER#a', orgId: 'org-a' },
      { pk: 'ORG#org-a', orgId: 'org-a' },
      { pk: 'CUSTOMER#b', orgId: 'org-b' },
    ];

    expect(preferOrgRows(rows)).toEqual([
      { pk: 'ORG#org-a', orgId: 'org-a' },
      { pk: 'CUSTOMER#b', orgId: 'org-b' },
    ]);
  });

  it('keeps two legacy rows for one org — that is a collision, not a twin', () => {
    const rows = [
      { pk: 'CUSTOMER#a', orgId: 'org-a' },
      { pk: 'CUSTOMER#b', orgId: 'org-a' },
    ];

    expect(preferOrgRows(rows)).toEqual(rows);
  });
});

describe('scanSubscriptions', () => {
  beforeEach(() => ddbMock.reset());

  const scanned = (fields: Parameters<typeof marshall>[0]) => marshall(fields);

  it('pages the scan and keeps one row per org, the org key winning', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [scanned({ pk: 'CUSTOMER#a', orgId: 'org-a', userId: 'a' })],
        LastEvaluatedKey: { pk: { S: 'CUSTOMER#a' } },
      })
      .resolvesOnce({
        Items: [
          scanned({ pk: 'ORG#org-a', orgId: 'org-a', userId: 'a' }),
          scanned({ pk: 'CUSTOMER#b', orgId: 'org-b', userId: 'b' }),
        ],
      });

    const rows = await scanSubscriptions({
      job: 'test',
      filterExpression: 'sk = :sk',
      expressionAttributeValues: { ':sk': { S: 'SUBSCRIPTION' } },
      select: (_record, owner) => owner,
    });

    expect(rows.map((row) => row.pk)).toEqual(['ORG#org-a', 'CUSTOMER#b']);
  });

  it('names both sides of a collision the org key cannot settle', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ddbMock.on(ScanCommand).resolves({
      Items: [
        scanned({ pk: 'CUSTOMER#a', orgId: 'org-a', userId: 'a', subscriptionId: 'sub_1' }),
        scanned({ pk: 'CUSTOMER#b', orgId: 'org-a', userId: 'b', subscriptionId: 'sub_2' }),
      ],
    });

    const rows = await scanSubscriptions<{ pk: string; orgId: string; subscriptionId: string }>({
      job: 'test',
      filterExpression: 'sk = :sk',
      expressionAttributeValues: { ':sk': { S: 'SUBSCRIPTION' } },
      select: (record, owner) => ({ ...owner, subscriptionId: record.subscriptionId as string }),
      describe: (row) => ({ subscriptionId: row.subscriptionId }),
    });

    // Two live subscriptions for one org is the collision the backfill halts on;
    // the job acts once and says which row it left behind, and on what.
    expect(rows).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      '[test] Second subscription row for one org, skipped',
      expect.objectContaining({
        orgId: 'org-a',
        processing: 'CUSTOMER#a',
        skipped: 'CUSTOMER#b',
        processingDetail: { subscriptionId: 'sub_1' },
        skippedDetail: { subscriptionId: 'sub_2' },
      }),
    );
    warn.mockRestore();
  });

  it('lets the job say which of two rows it would rather act on', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        scanned({ pk: 'CUSTOMER#a', orgId: 'org-a', userId: 'a', rank: 1 }),
        scanned({ pk: 'CUSTOMER#b', orgId: 'org-a', userId: 'b', rank: 2 }),
      ],
    });

    const rows = await scanSubscriptions<{ pk: string; orgId: string; rank: number }>({
      job: 'test',
      filterExpression: 'sk = :sk',
      expressionAttributeValues: { ':sk': { S: 'SUBSCRIPTION' } },
      select: (record, owner) => ({ ...owner, rank: Number(record.rank) }),
      prefer: (held, next) => (next.rank > held.rank ? next : held),
    });

    expect(rows.map((row) => row.pk)).toEqual(['CUSTOMER#b']);
  });

  it('warns about an org row that names no user', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ddbMock.on(ScanCommand).resolves({ Items: [scanned({ pk: 'ORG#org-a', orgId: 'org-a' })] });

    await scanSubscriptions({
      job: 'test',
      filterExpression: 'sk = :sk',
      expressionAttributeValues: { ':sk': { S: 'SUBSCRIPTION' } },
      select: (_record, owner) => owner,
    });

    // The close-out paths need it, and after the flip there is no pk left to
    // recover it from.
    expect(warn).toHaveBeenCalledWith('[test] Subscription row with no userId', {
      pk: 'ORG#org-a',
    });
    warn.mockRestore();
  });
});

describe('SubscriptionKeys', () => {
  it('parses a user id out of a legacy key and refuses every other shape', () => {
    expect(SubscriptionKeys.parseLegacyPk('CUSTOMER#user-1')).toBe('user-1');
    expect(SubscriptionKeys.parseLegacyPk('ORG#org-1')).toBeUndefined();
    expect(SubscriptionKeys.parseLegacyPk('CUSTOMER#')).toBeUndefined();
    // Org ids and user ids are UUIDs; a `#` in the tail means the key is not
    // what it claims to be, so it is refused rather than half-parsed.
    expect(SubscriptionKeys.parseLegacyPk('CUSTOMER#a#b')).toBeUndefined();
  });
});
