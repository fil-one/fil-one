import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { OrgRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './owner-count-drift-checker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ID = 'org-a';
const OTHER_ORG_ID = 'org-b';

// The projected shape, and only that: the job reads pk, sk, role and
// ownerCount, so a fixture carrying more would test a row the scan never sees.
function memberRow(orgId: string, userId: string, role: string = OrgRole.Owner) {
  return marshall({ pk: `ORG#${orgId}`, sk: `MEMBER#${userId}`, role });
}

function metaRow(orgId: string, ownerCount?: number) {
  return marshall({
    pk: `ORG#${orgId}`,
    sk: 'META',
    ...(ownerCount === undefined ? {} : { ownerCount }),
  });
}

function updateInputs() {
  return ddbMock.commandCalls(UpdateItemCommand).map((call) => call.args[0].input);
}

function putInputs() {
  return ddbMock.commandCalls(PutItemCommand).map((call) => call.args[0].input);
}

function envelopes(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  const calls = spy.mock.calls as unknown as unknown[][];
  return calls
    .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .filter((parsed) => parsed._aws !== undefined);
}

/** The run's summary envelope, off the stdout the metrics module writes to. */
function emission(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const summaries = envelopes(spy).filter((parsed) => parsed.OwnerCountDrift !== undefined);
  expect(summaries).toHaveLength(1);
  return summaries[0];
}

/** One data point per applied repair, which is what an alarm watches. */
function repairsEmitted(spy: ReturnType<typeof vi.spyOn>): number {
  return envelopes(spy).filter((parsed) => parsed.OwnerCountRepaired !== undefined).length;
}

/**
 * The org's own partition, read consistently, which is what every repair is
 * written from. The Scan only decides which orgs to look at.
 */
function stubPartition(orgId: string, items: Record<string, unknown>[]) {
  ddbMock
    .on(QueryCommand, {
      TableName: 'OrgTable',
      ExpressionAttributeValues: { ':pk': { S: `ORG#${orgId}` } },
    })
    .resolves({ Items: items as never });
}

function logsMatching(spy: ReturnType<typeof vi.spyOn>, message: string) {
  const calls = spy.mock.calls as unknown as unknown[][];
  return calls.filter((call) => call[0] === `[owner-count-drift-checker] ${message}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('owner-count-drift-checker', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('writes nothing when the counter matches the membership rows', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [metaRow(ORG_ID, 2), memberRow(ORG_ID, 'user-1'), memberRow(ORG_ID, 'user-2')],
    });

    await handler();

    expect(updateInputs()).toHaveLength(0);
    expect(putInputs()).toHaveLength(0);
    // An org the Scan finds in order costs nothing further: the per-org read is
    // what a repair is written from, and there is no repair here.
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(emission(stdoutSpy)).toMatchObject({
      OwnerCountDrift: 0,
      OwnerCountRepairFailed: 0,
      OrgsWithNoOwner: 0,
    });
  });

  it('scans OrgTable projecting only the attributes the recount reads', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler();

    const scans = ddbMock.commandCalls(ScanCommand);
    expect(scans).toHaveLength(1);
    expect(scans[0].args[0].input).toMatchObject({
      TableName: 'OrgTable',
      ProjectionExpression: 'pk, sk, #role, ownerCount',
      ExpressionAttributeNames: { '#role': 'role' },
    });
  });

  it('repairs a counter that is too high, conditioned on the value it recounted', async () => {
    const rows = [
      metaRow(ORG_ID, 3),
      memberRow(ORG_ID, 'user-1'),
      memberRow(ORG_ID, 'user-2', OrgRole.Admin),
    ];
    ddbMock.on(ScanCommand).resolves({ Items: rows });
    stubPartition(ORG_ID, rows);

    await handler();

    // The repair is written from the org's own partition, read consistently —
    // a Scan reads each item at whatever moment it reaches it, and a counter
    // written from a count no instant ever held is what put us here.
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      TableName: 'OrgTable',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': { S: `ORG#${ORG_ID}` } },
      ConsistentRead: true,
    });

    expect(updateInputs()).toEqual([
      {
        TableName: 'OrgTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'META' } },
        UpdateExpression: 'SET ownerCount = :counted',
        ConditionExpression: 'ownerCount = :stale',
        ExpressionAttributeValues: { ':counted': { N: '1' }, ':stale': { N: '3' } },
      },
    ]);
    expect(logsMatching(logSpy, 'counter diverged')[0][1]).toMatchObject({
      orgId: ORG_ID,
      stored: 3,
      counted: 1,
    });
    expect(repairsEmitted(stdoutSpy)).toBe(1);
    expect(emission(stdoutSpy)).toMatchObject({
      OwnerCountDrift: 1,
      OwnerCountRepairFailed: 0,
      OrgsWithNoOwner: 0,
    });
  });

  it('repairs a counter that is too low', async () => {
    const rows = [metaRow(ORG_ID, 1), memberRow(ORG_ID, 'user-1'), memberRow(ORG_ID, 'user-2')];
    ddbMock.on(ScanCommand).resolves({ Items: rows });
    stubPartition(ORG_ID, rows);

    await handler();

    expect(updateInputs()).toEqual([
      {
        TableName: 'OrgTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'META' } },
        UpdateExpression: 'SET ownerCount = :counted',
        ConditionExpression: 'ownerCount = :stale',
        ExpressionAttributeValues: { ':counted': { N: '2' }, ':stale': { N: '1' } },
      },
    ]);
    expect(emission(stdoutSpy)).toMatchObject({ OwnerCountDrift: 1 });
  });

  it('follows pagination, tallying an org whose rows span two pages', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [metaRow(ORG_ID, 1), memberRow(ORG_ID, 'user-1')],
        LastEvaluatedKey: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'MEMBER#user-1' } },
      })
      .resolvesOnce({
        Items: [
          memberRow(ORG_ID, 'user-2'),
          metaRow(OTHER_ORG_ID, 1),
          memberRow(OTHER_ORG_ID, 'u'),
        ],
      });

    stubPartition(ORG_ID, [
      metaRow(ORG_ID, 1),
      memberRow(ORG_ID, 'user-1'),
      memberRow(ORG_ID, 'user-2'),
    ]);

    await handler();

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    // Only the org whose second Owner arrived on page two is out of date; the
    // org that is entirely on page two is correct and untouched.
    expect(updateInputs()).toEqual([
      {
        TableName: 'OrgTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'META' } },
        UpdateExpression: 'SET ownerCount = :counted',
        ConditionExpression: 'ownerCount = :stale',
        ExpressionAttributeValues: { ':counted': { N: '2' }, ':stale': { N: '1' } },
      },
    ]);
    expect(emission(stdoutSpy)).toMatchObject({ OwnerCountDrift: 1 });
  });

  it('writes nothing when the recount agrees with the counter the Scan doubted', async () => {
    // The Scan straddled a transaction: it saw the demoted half and not the
    // promoted one. The org is fine, and a repair written from that reading
    // would set the counter to a number no instant ever held.
    ddbMock.on(ScanCommand).resolves({
      Items: [metaRow(ORG_ID, 2), memberRow(ORG_ID, 'user-1')],
    });
    stubPartition(ORG_ID, [
      metaRow(ORG_ID, 2),
      memberRow(ORG_ID, 'user-1'),
      memberRow(ORG_ID, 'user-2'),
    ]);

    await handler();

    expect(updateInputs()).toHaveLength(0);
    expect(putInputs()).toHaveLength(0);
    expect(emission(stdoutSpy)).toMatchObject({ OwnerCountDrift: 0, OrgsWithNoOwner: 0 });
  });

  it('never writes the Scan’s count upward over a counter that is right', async () => {
    // The direction that matters: an inflated counter defeats `ownerCount > :one`
    // and lets the last Owner be removed. The recount is what the write says.
    ddbMock.on(ScanCommand).resolves({
      Items: [
        metaRow(ORG_ID, 1),
        memberRow(ORG_ID, 'user-1'),
        memberRow(ORG_ID, 'user-2'),
        memberRow(ORG_ID, 'user-3'),
      ],
    });
    stubPartition(ORG_ID, [metaRow(ORG_ID, 1), memberRow(ORG_ID, 'user-1')]);

    await handler();

    expect(updateInputs()).toHaveLength(0);
  });

  it('leaves an org for the next run when its recount fails', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [metaRow(ORG_ID, 3), memberRow(ORG_ID, 'user-1')] });
    ddbMock.on(QueryCommand).rejects(new Error('ProvisionedThroughputExceededException'));

    await handler();

    expect(updateInputs()).toHaveLength(0);
    expect(logsMatching(errorSpy, 'recount failed — org left for the next run')).toHaveLength(1);
    expect(emission(stdoutSpy)).toMatchObject({ OwnerCountRepairFailed: 1 });
  });

  it('creates the META row for an org that has members and no counter', async () => {
    const rows = [memberRow(ORG_ID, 'user-1'), memberRow(ORG_ID, 'user-2', OrgRole.Member)];
    ddbMock.on(ScanCommand).resolves({ Items: rows });
    stubPartition(ORG_ID, rows);

    await handler();

    expect(putInputs()).toEqual([
      {
        TableName: 'OrgTable',
        Item: {
          pk: { S: `ORG#${ORG_ID}` },
          sk: { S: 'META' },
          ownerCount: { N: '1' },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    ]);
    expect(updateInputs()).toHaveLength(0);
    expect(logsMatching(errorSpy, 'org has membership rows and no META row')[0][1]).toMatchObject({
      orgId: ORG_ID,
      members: 2,
      counted: 1,
    });
    expect(emission(stdoutSpy)).toMatchObject({ OwnerCountDrift: 1, OwnerCountRepairFailed: 0 });
  });

  it('repairs a META row that carries no counter, conditioned on its absence', async () => {
    const rows = [metaRow(ORG_ID), memberRow(ORG_ID, 'user-1')];
    ddbMock.on(ScanCommand).resolves({ Items: rows });
    stubPartition(ORG_ID, rows);

    await handler();

    expect(updateInputs()).toEqual([
      {
        TableName: 'OrgTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'META' } },
        UpdateExpression: 'SET ownerCount = :counted',
        ConditionExpression: 'attribute_not_exists(ownerCount)',
        ExpressionAttributeValues: { ':counted': { N: '1' } },
      },
    ]);
    expect(putInputs()).toHaveLength(0);
    expect(emission(stdoutSpy)).toMatchObject({ OwnerCountDrift: 1 });
  });

  it('reports an org with no Owner and still repairs the counter to zero', async () => {
    const rows = [metaRow(ORG_ID, 1), memberRow(ORG_ID, 'user-1', OrgRole.Admin)];
    ddbMock.on(ScanCommand).resolves({ Items: rows });
    stubPartition(ORG_ID, rows);

    await handler();

    expect(logsMatching(errorSpy, 'org has no Owner')[0][1]).toMatchObject({
      orgId: ORG_ID,
      members: 1,
      storedOwnerCount: 1,
    });
    expect(updateInputs()[0]).toMatchObject({
      ExpressionAttributeValues: { ':counted': { N: '0' }, ':stale': { N: '1' } },
    });
    expect(emission(stdoutSpy)).toMatchObject({ OrgsWithNoOwner: 1, OwnerCountDrift: 1 });
  });

  it('does not count an unrecognized role as an Owner', async () => {
    const rows = [
      metaRow(ORG_ID, 2),
      memberRow(ORG_ID, 'user-1'),
      memberRow(ORG_ID, 'user-2', 'wizard'),
    ];
    ddbMock.on(ScanCommand).resolves({ Items: rows });
    stubPartition(ORG_ID, rows);

    await handler();

    expect(
      logsMatching(errorSpy, 'membership row carries an unrecognized role')[0][1],
    ).toMatchObject({ orgId: ORG_ID, sk: 'MEMBER#user-2', role: 'wizard' });
    expect(updateInputs()[0]).toMatchObject({
      ExpressionAttributeValues: { ':counted': { N: '1' }, ':stale': { N: '2' } },
    });
  });

  it('treats a repair that lost its condition as the counter having moved', async () => {
    const rows = [metaRow(ORG_ID, 3), memberRow(ORG_ID, 'user-1')];
    ddbMock.on(ScanCommand).resolves({ Items: rows });
    stubPartition(ORG_ID, rows);
    ddbMock
      .on(UpdateItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'moved', $metadata: {} }));

    await handler();

    expect(logsMatching(logSpy, 'repair skipped, the counter moved')[0][1]).toMatchObject({
      orgId: ORG_ID,
      stored: 3,
      counted: 1,
    });
    expect(logsMatching(errorSpy, 'repair failed')).toHaveLength(0);
    expect(repairsEmitted(stdoutSpy)).toBe(0);
    expect(emission(stdoutSpy)).toMatchObject({ OwnerCountDrift: 1, OwnerCountRepairFailed: 0 });
  });

  it('ignores the USER# inverse items and the INVITETOKEN# partitions', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        metaRow(ORG_ID, 1),
        memberRow(ORG_ID, 'user-1'),
        // The inverse item carries a denormalized role and would double the count.
        marshall({ pk: 'USER#user-1', sk: `MEMBERSHIP#${ORG_ID}`, role: OrgRole.Owner }),
        marshall({ pk: 'INVITETOKEN#hash', sk: 'LOOKUP' }),
        // An invitation row in the org's own partition is projected down to keys.
        marshall({ pk: `ORG#${ORG_ID}`, sk: 'INVITE#invite-1', role: OrgRole.Owner }),
      ],
    });

    await handler();

    expect(updateInputs()).toHaveLength(0);
    expect(putInputs()).toHaveLength(0);
    expect(logsMatching(errorSpy, 'membership row carries an unrecognized role')).toHaveLength(0);
    expect(emission(stdoutSpy)).toMatchObject({ OwnerCountDrift: 0, OrgsWithNoOwner: 0 });
  });

  it('counts a failed repair and reconciles the remaining orgs', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        metaRow(ORG_ID, 5),
        memberRow(ORG_ID, 'user-1'),
        metaRow(OTHER_ORG_ID, 4),
        memberRow(OTHER_ORG_ID, 'user-2'),
      ],
    });
    stubPartition(ORG_ID, [metaRow(ORG_ID, 5), memberRow(ORG_ID, 'user-1')]);
    stubPartition(OTHER_ORG_ID, [metaRow(OTHER_ORG_ID, 4), memberRow(OTHER_ORG_ID, 'user-2')]);
    ddbMock
      .on(UpdateItemCommand)
      .rejectsOnce(new Error('ProvisionedThroughputExceededException'))
      .resolvesOnce({});

    await handler();

    expect(updateInputs()).toHaveLength(2);
    expect(logsMatching(errorSpy, 'repair failed')[0][1]).toMatchObject({
      orgId: ORG_ID,
      stored: 5,
      counted: 1,
    });
    expect(logsMatching(logSpy, 'counter repaired')[0][1]).toMatchObject({
      orgId: OTHER_ORG_ID,
      stored: 4,
      counted: 1,
    });
    expect(emission(stdoutSpy)).toMatchObject({ OwnerCountDrift: 2, OwnerCountRepairFailed: 1 });
  });
});
