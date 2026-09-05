import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
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
  assertOneRowPerOrg,
  readSubscription,
  type ScannedSubscription,
  scannedSubscription,
  scanSubscriptions,
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

  it('reads the org’s row and nothing else', async () => {
    // One org, one subscription: membership in an org means riding that org's
    // billing, so a member with no row of their own is served by this read.
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves(row({ pk: `ORG#${ORG_ID}`, sk: 'SUBSCRIPTION', orgId: ORG_ID, userId: USER_ID }));

    const record = await readSubscription(ORG_ID);

    expect(record?.orgId).toBe(ORG_ID);
    const reads = ddbMock.commandCalls(GetItemCommand);
    expect(reads).toHaveLength(1);
    expect(reads[0].args[0].input.Key).toStrictEqual(ORG_KEY);
  });

  it('never reads the caller’s legacy key, even when the org has no row', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    expect(await readSubscription(ORG_ID)).toBeUndefined();
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(GetItemCommand, { Key: LEGACY_KEY })).toHaveLength(0);
  });

  it('carries the read options through', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    await readSubscription(ORG_ID, { consistentRead: true, projectionExpression: 'pk' });

    expect(ddbMock.commandCalls(GetItemCommand)[0].args[0].input).toMatchObject({
      ConsistentRead: true,
      ProjectionExpression: 'pk',
    });
  });
});

describe('updateSubscription', () => {
  beforeEach(() => ddbMock.reset());

  it('writes the org’s row once, guarded on the row already existing', async () => {
    // A SET on a key with no row creates one out of whatever this expression
    // happened to name. Before the re-key the legacy row absorbed that; now this
    // key is the only one anyone reads, so a phantom row IS the billing state.
    ddbMock.on(UpdateItemCommand).resolves({});

    await updateSubscription({ orgId: ORG_ID, userId: USER_ID }, SET_STATUS);

    const calls = ddbMock.commandCalls(UpdateItemCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toStrictEqual({
      TableName: 'BillingTable',
      Key: ORG_KEY,
      ...SET_STATUS,
      ConditionExpression: 'attribute_exists(pk)',
    });
  });

  it('lets a writer that puts a whole record create it', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await updateSubscription(
      { orgId: ORG_ID, userId: USER_ID },
      { ...SET_STATUS, createsRow: true },
    );

    expect(
      ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input.ConditionExpression,
    ).toBeUndefined();
  });

  it('holds the row to the caller’s condition as well as its own existence', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await updateSubscription(
      { orgId: ORG_ID, userId: USER_ID },
      { ...SET_STATUS, ConditionExpression: 'attribute_exists(stripeCustomerId)' },
    );

    expect(ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input.ConditionExpression).toBe(
      'attribute_exists(pk) AND (attribute_exists(stripeCustomerId))',
    );
  });

  it('lets a failed condition reach the caller', async () => {
    // There is no second row to fall back to, so a refused write is the
    // caller's to interpret rather than something this module absorbs.
    ddbMock.on(UpdateItemCommand).rejects(conditionFailed());

    await expect(
      updateSubscription({ orgId: ORG_ID, userId: USER_ID }, SET_STATUS),
    ).rejects.toThrow('The conditional request failed');
  });

  it('reports a missing row for a caller that tolerates one', async () => {
    ddbMock.on(UpdateItemCommand).rejects(conditionFailed());

    const result = await updateSubscription(
      { orgId: ORG_ID, userId: USER_ID },
      { ...SET_STATUS, tolerateMissingRow: true },
    );

    expect(result).toStrictEqual({ written: false });
  });

  it('still raises a caller condition a tolerant caller’s row refused', async () => {
    // "The row is not there" is the only failure that is an outcome. A condition
    // about the record is a fact about the record.
    ddbMock.on(UpdateItemCommand).rejects(conditionFailed());

    await expect(
      updateSubscription(
        { orgId: ORG_ID, userId: USER_ID },
        { ...SET_STATUS, tolerateMissingRow: true, ConditionExpression: 'attribute_exists(x)' },
      ),
    ).rejects.toThrow('The conditional request failed');
  });

  it('returns the row’s prior attributes', async () => {
    ddbMock
      .on(UpdateItemCommand)
      .resolves({ Attributes: { subscriptionStatus: { S: 'grace_period' } } });

    const result = await updateSubscription(
      { orgId: ORG_ID, userId: USER_ID },
      { ...SET_STATUS, ReturnValues: 'ALL_OLD' },
    );

    expect(result.previous?.subscriptionStatus).toStrictEqual({ S: 'grace_period' });
  });
});

describe('updateSubscriptionByUser', () => {
  beforeEach(() => ddbMock.reset());

  it('writes the org’s row when the org is known', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await updateSubscriptionByUser({ orgId: ORG_ID, userId: USER_ID }, SET_STATUS);

    expect(ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input.Key).toStrictEqual(ORG_KEY);
  });

  it('throws when no org is named, rather than reporting success', async () => {
    // The key names the org and nothing else, so without one there is no row to
    // address. The caller is a webhook handler: throwing becomes a 500, which
    // releases the idempotency claim, so Stripe's retries converge once somebody
    // repairs the object's metadata. Returning success consumes the event and
    // the status change it carried goes with it.
    ddbMock.on(UpdateItemCommand).resolves({});

    await expect(updateSubscriptionByUser({ userId: USER_ID }, SET_STATUS)).rejects.toThrow(
      'names no orgId',
    );
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('leaves userId off the row rather than stamping an empty string', async () => {
    // Every lifecycle job reads the attribute, and '' is a user id that matches
    // nothing while looking like an answer.
    ddbMock.on(PutItemCommand).resolves({});

    await writeSubscription({ orgId: ORG_ID }, { item: {} });

    expect(ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item).not.toHaveProperty('userId');
  });
});

describe('writeSubscription', () => {
  beforeEach(() => ddbMock.reset());

  it('creates the org’s row, stamped with the org and the user', async () => {
    ddbMock.on(PutItemCommand).resolves({});

    await writeSubscription(
      { orgId: ORG_ID, userId: USER_ID },
      {
        item: { stripeCustomerId: { S: 'cus_1' } },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    );

    const calls = ddbMock.commandCalls(PutItemCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Item).toStrictEqual({
      pk: { S: `ORG#${ORG_ID}` },
      sk: { S: 'SUBSCRIPTION' },
      orgId: { S: ORG_ID },
      // An attribute rather than part of the key, so the paths that close out a
      // deleted Stripe customer still have a user to name.
      userId: { S: USER_ID },
      stripeCustomerId: { S: 'cus_1' },
    });
    expect(calls[0].args[0].input.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  it('lets a failed condition reach the caller', async () => {
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
  it('takes the org and the user from the row’s own attributes', () => {
    expect(
      scannedSubscription({ pk: `ORG#${ORG_ID}`, orgId: ORG_ID, userId: USER_ID }),
    ).toStrictEqual({ pk: `ORG#${ORG_ID}`, orgId: ORG_ID, userId: USER_ID });
  });

  it('never parses a user id out of the partition key', () => {
    // The key names an org. A job that parsed it would read an org id and call
    // it a user on every row in the table.
    expect(scannedSubscription({ pk: `CUSTOMER#${USER_ID}`, orgId: ORG_ID })).toStrictEqual({
      pk: `CUSTOMER#${USER_ID}`,
      orgId: ORG_ID,
    });
  });

  it('reports a row with no orgId as unusable', () => {
    expect(scannedSubscription({ pk: `ORG#${ORG_ID}` })).toBeUndefined();
  });
});

describe('assertOneRowPerOrg', () => {
  let logged: ReturnType<typeof vi.spyOn>;
  let warned: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('passes a table holding one row per org through untouched', () => {
    const rows = [
      { pk: 'ORG#a', orgId: 'a', userId: 'u1' },
      { pk: 'ORG#b', orgId: 'b', userId: 'u2' },
    ];

    expect(assertOneRowPerOrg(rows, 'a-job')).toEqual(rows);
    expect(logged).not.toHaveBeenCalled();
  });

  it('warns about a leftover CUSTOMER# row beside its org row', () => {
    // The expected state between the flip and the dated cleanup step. Paging
    // somebody at 3am for it would teach them to ignore the alert that matters.
    // A direct call like this one is the only way to reach the branch: a job's
    // scan drops non-org rows before the dedupe sees them, and reports each as
    // `Not an org row, skipping`.
    const rows = [
      { pk: 'ORG#a', orgId: 'a', userId: 'u1' },
      { pk: 'CUSTOMER#u2', orgId: 'a', userId: 'u2' },
    ];

    expect(assertOneRowPerOrg(rows, 'a-job')).toEqual([rows[0]]);
    expect(logged).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0][0]).toBe('[a-job] Leftover CUSTOMER# row beside its org row');
    expect(warned.mock.calls[0][1]).toMatchObject({
      orgId: 'a',
      processing: 'ORG#a',
      ignored: 'CUSTOMER#u2',
    });
  });

  it('errors on two rows of the same kind, naming what each would bill', () => {
    // The real violation: two live subscriptions for one org. Which one Stripe
    // is billing is the first thing anybody will ask.
    const rows = [
      { pk: 'ORG#a', orgId: 'a', userId: 'u1', subscriptionId: 'sub_1' },
      { pk: 'ORG#a', orgId: 'a', userId: 'u2', subscriptionId: 'sub_2' },
    ];

    expect(assertOneRowPerOrg(rows, 'a-job')).toEqual([rows[0]]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toBe(
      '[a-job] INVARIANT VIOLATED: two subscription rows for one org',
    );
    expect(logged.mock.calls[0][1]).toMatchObject({
      processingSubscriptionId: 'sub_1',
      ignoredSubscriptionId: 'sub_2',
    });
  });

  it('keeps the org-keyed row whatever order the scan returned them in', () => {
    // Not scan order: a surviving `CUSTOMER#` row is the one no writer can
    // address, so keeping it would meter its subscription to Stripe from the
    // usage orchestrator and bill the org on a row nothing else can see.
    const legacy = { pk: 'CUSTOMER#u2', orgId: 'a', userId: 'u2' };
    const org = { pk: 'ORG#a', orgId: 'a', userId: 'u1' };

    expect(assertOneRowPerOrg([legacy, org], 'a-job')).toEqual([org]);
    expect(assertOneRowPerOrg([org, legacy], 'a-job')).toEqual([org]);
    expect(
      warned.mock.calls.map((call: unknown[]) => (call[1] as { processing: string }).processing),
    ).toEqual(['ORG#a', 'ORG#a']);
  });

  it('names the job that found the violation', () => {
    assertOneRowPerOrg(
      [
        { pk: 'ORG#a', orgId: 'a' },
        { pk: 'ORG#a', orgId: 'a' },
      ],
      'grace-period-enforcer',
    );

    expect(logged.mock.calls[0][0]).toContain('[grace-period-enforcer]');
  });
});

describe('SubscriptionKeys', () => {
  it('keys a subscription by its org', () => {
    expect(SubscriptionKeys.orgPk(ORG_ID)).toBe(`ORG#${ORG_ID}`);
    expect(SubscriptionKeys.sk()).toBe('SUBSCRIPTION');
    expect(SubscriptionKeys.isOrgPk(`ORG#${ORG_ID}`)).toBe(true);
    expect(SubscriptionKeys.isOrgPk(`CUSTOMER#${USER_ID}`)).toBe(false);
  });

  it('still recognizes a pre-re-key row, for the cleanup step that deletes them', () => {
    expect(SubscriptionKeys.legacyPk(USER_ID)).toBe(`CUSTOMER#${USER_ID}`);
    expect(SubscriptionKeys.parseLegacyPk(`CUSTOMER#${USER_ID}`)).toBe(USER_ID);
    expect(SubscriptionKeys.parseLegacyPk(`ORG#${ORG_ID}`)).toBeUndefined();
    expect(SubscriptionKeys.parseLegacyPk('CUSTOMER#')).toBeUndefined();
    // Ids are UUIDs; a `#` in the tail means the key is not what it claims.
    expect(SubscriptionKeys.parseLegacyPk('CUSTOMER#a#b')).toBeUndefined();
  });
});

describe('scanSubscriptions', () => {
  beforeEach(() => ddbMock.reset());

  /** A distinct org per row, so `assertOneRowPerOrg` keeps every one of them. */
  function orgRow(n: number) {
    return marshall({
      pk: `ORG#org-${n}`,
      sk: 'SUBSCRIPTION',
      orgId: `org-${n}`,
      userId: `user-${n}`,
    });
  }

  function page(count: number, { from = 0, more = false } = {}) {
    return {
      Items: Array.from({ length: count }, (_, i) => orgRow(from + i)) as never,
      ...(more ? { LastEvaluatedKey: { pk: { S: 'cursor' } } } : {}),
    };
  }

  const options = {
    job: 'test-job',
    filterExpression: 'sk = :sk',
    expressionAttributeValues: { ':sk': { S: 'SUBSCRIPTION' } },
    select: (_record: Record<string, unknown>, owner: ScannedSubscription) => owner,
  };

  const orgIds = (rows: ScannedSubscription[]) => rows.map((r) => r.orgId);

  it('stops paging once the limit is reached', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce(page(3, { more: true }))
      .resolvesOnce(page(3, { from: 3 }));

    const rows = await scanSubscriptions({ ...options, limit: 3 });

    expect(orgIds(rows)).toEqual(['org-0', 'org-1', 'org-2']);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  it('returns no more than the limit when a single page overshoots it', async () => {
    ddbMock.on(ScanCommand).resolves(page(10, { more: true }));

    const rows = await scanSubscriptions({ ...options, limit: 3 });

    expect(orgIds(rows)).toEqual(['org-0', 'org-1', 'org-2']);
  });

  it('lets a caller asking for one extra tell a full batch from a backlog', async () => {
    ddbMock.on(ScanCommand).resolves(page(3));
    expect(await scanSubscriptions({ ...options, limit: 4 })).toHaveLength(3);

    ddbMock.reset();
    ddbMock.on(ScanCommand).resolves(page(10, { more: true }));
    expect(await scanSubscriptions({ ...options, limit: 4 })).toHaveLength(4);
  });

  it('pages to exhaustion when no limit is given', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce(page(2, { more: true }))
      .resolvesOnce(page(2, { from: 2 }));

    const rows = await scanSubscriptions(options);

    expect(orgIds(rows)).toEqual(['org-0', 'org-1', 'org-2', 'org-3']);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
  });
});
