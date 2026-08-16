import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
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

const SET_STATUS = {
  UpdateExpression: 'SET subscriptionStatus = :status',
  ExpressionAttributeValues: { ':status': { S: 'active' } },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('readSubscription', () => {
  beforeEach(() => ddbMock.reset());

  it('answers from the org key and never reads the legacy one', async () => {
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves(row({ pk: `ORG#${ORG_ID}`, sk: 'SUBSCRIPTION', orgId: ORG_ID }));

    const stored = await readSubscription(ORG_ID, USER_ID);

    expect(stored?.key).toBe('org');
    expect(stored?.record.orgId).toBe(ORG_ID);
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(1);
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
    });
    expect(result.orgRowWritten).toBe(true);
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
    expect(calls[0].args[0].input.ConditionExpression).toBe(
      'attribute_exists(pk) AND (attribute_exists(stripeCustomerId))',
    );
    expect(calls[1].args[0].input.ConditionExpression).toBe('attribute_exists(stripeCustomerId)');
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
    expect(result.orgRowWritten).toBe(false);
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

  it('creates both rows, each stamped with the org and the user', async () => {
    ddbMock.on(PutItemCommand).resolves({});

    await writeSubscription(
      { orgId: ORG_ID, userId: USER_ID },
      {
        item: { stripeCustomerId: { S: 'cus_1' } },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    );

    const items = ddbMock.commandCalls(PutItemCommand).map((call) => call.args[0].input.Item);
    expect(items).toEqual([
      {
        pk: { S: `ORG#${ORG_ID}` },
        sk: { S: 'SUBSCRIPTION' },
        orgId: { S: ORG_ID },
        userId: { S: USER_ID },
        stripeCustomerId: { S: 'cus_1' },
      },
      {
        pk: { S: `CUSTOMER#${USER_ID}` },
        sk: { S: 'SUBSCRIPTION' },
        orgId: { S: ORG_ID },
        userId: { S: USER_ID },
        stripeCustomerId: { S: 'cus_1' },
      },
    ]);
  });

  it('still creates the legacy row when the org row is already there', async () => {
    ddbMock
      .on(PutItemCommand, { Item: { pk: { S: `ORG#${ORG_ID}` } } })
      .rejects(conditionFailed())
      .on(PutItemCommand, { Item: { pk: { S: `CUSTOMER#${USER_ID}` } } })
      .resolves({});

    await writeSubscription(
      { orgId: ORG_ID, userId: USER_ID },
      {
        item: { stripeCustomerId: { S: 'cus_1' } },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    );

    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(2);
  });

  it('lets the legacy row’s condition failure reach the caller', async () => {
    // Today's behavior: the caller decides what an existing record means.
    ddbMock
      .on(PutItemCommand, { Item: { pk: { S: `ORG#${ORG_ID}` } } })
      .resolves({})
      .on(PutItemCommand, { Item: { pk: { S: `CUSTOMER#${USER_ID}` } } })
      .rejects(conditionFailed());

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
