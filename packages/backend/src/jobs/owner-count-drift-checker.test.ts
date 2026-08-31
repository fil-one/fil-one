import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
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

function metaRow(orgId: string, ownerCount?: number, ownerSetRev?: number) {
  return marshall({
    pk: `ORG#${orgId}`,
    sk: 'META',
    ...(ownerCount === undefined ? {} : { ownerCount }),
    ...(ownerSetRev === undefined ? {} : { ownerSetRev }),
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
 *
 * Two reads, because the recount makes two: the META row on its own, ahead of
 * the member pages, and then the members.
 */
function stubPartition(orgId: string, items: Record<string, unknown>[]) {
  stubOrgMeta(orgId, items.find(isMetaRow));
  stubMemberPages(orgId).resolves({ Items: items.filter((item) => !isMetaRow(item)) as never });
}

function isMetaRow(item: Record<string, unknown>): boolean {
  return (item as { sk?: { S?: string } }).sk?.S === 'META';
}

/**
 * The org profile row the deletion fence reads. Live unless a test says
 * otherwise: the row is retained through teardown and beyond, so its absence
 * means an org this job must not touch.
 */
function stubOrgProfile(orgId: string, attributes: Record<string, unknown> = {}) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({ Item: marshall({ pk: `ORG#${orgId}`, sk: 'PROFILE', ...attributes }) as never });
}

/** The counter read the recount takes before it pages anything. */
function stubOrgMeta(orgId: string, meta: Record<string, unknown> | undefined) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'META' } },
    })
    .resolves(meta ? { Item: meta as never } : {});
}

function stubMemberPages(orgId: string) {
  return ddbMock.on(QueryCommand, {
    TableName: 'OrgTable',
    ExpressionAttributeValues: { ':pk': { S: `ORG#${orgId}` } },
  });
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
    // An org with no META row, until a test stubs one.
    ddbMock.on(GetItemCommand).resolves({});
    stubOrgProfile(ORG_ID);
    stubOrgProfile(OTHER_ORG_ID);
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
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :memberPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `ORG#${ORG_ID}` },
        ':memberPrefix': { S: 'MEMBER#' },
      },
      ConsistentRead: true,
    });
    // And the counter it conditions on comes from its own read of the META row,
    // taken before the pages rather than off whichever one it landed on.
    const metaRead = ddbMock
      .commandCalls(GetItemCommand)
      .map((call) => call.args[0].input)
      .find((input) => input.TableName === 'OrgTable')!;
    expect(metaRead).toMatchObject({
      Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'META' } },
      ConsistentRead: true,
    });

    expect(updateInputs()).toEqual([
      {
        TableName: 'OrgTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'META' } },
        UpdateExpression: 'SET ownerCount = :counted',
        ConditionExpression: 'ownerCount = :stale AND attribute_not_exists(ownerSetRev)',
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
        ConditionExpression: 'ownerCount = :stale AND attribute_not_exists(ownerSetRev)',
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
        ConditionExpression: 'ownerCount = :stale AND attribute_not_exists(ownerSetRev)',
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

  it('leaves a deleting org alone rather than putting its META row back', async () => {
    // The scrub deletes the META row before the member rows, so a recount inside
    // that window sees members and no counter — exactly the shape that mints a
    // fresh META row, in a partition the teardown has already enumerated.
    const rows = [memberRow(ORG_ID, 'user-1')];
    ddbMock.on(ScanCommand).resolves({ Items: rows });
    stubPartition(ORG_ID, rows);
    stubOrgProfile(ORG_ID, { deleting: true });

    await handler();

    expect(putInputs()).toHaveLength(0);
    expect(updateInputs()).toHaveLength(0);
    // Not even the recount: its answer is the only thing a repair knows.
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(logsMatching(logSpy, 'org is being deleted — left alone')).toHaveLength(1);
  });

  it('treats a missing org profile as deleted', async () => {
    // The profile row is retained through teardown and beyond, so its absence is
    // an org whose rows this run outlived rather than a live one.
    const rows = [metaRow(ORG_ID, 3), memberRow(ORG_ID, 'user-1')];
    ddbMock.on(ScanCommand).resolves({ Items: rows });
    stubPartition(ORG_ID, rows);
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({});

    await handler();

    expect(updateInputs()).toHaveLength(0);
  });

  it('leaves an org for the next run when its deletion fence cannot be read', async () => {
    const rows = [metaRow(ORG_ID, 3), memberRow(ORG_ID, 'user-1')];
    ddbMock.on(ScanCommand).resolves({ Items: rows });
    stubPartition(ORG_ID, rows);
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .rejects(new Error('ProvisionedThroughputExceededException'));

    await handler();

    expect(updateInputs()).toHaveLength(0);
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
        ConditionExpression:
          'attribute_not_exists(ownerCount) AND attribute_not_exists(ownerSetRev)',
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

  it('conditions the repair on the owner-set revision it recounted', async () => {
    const rows = [metaRow(ORG_ID, 3, 7), memberRow(ORG_ID, 'user-1')];
    ddbMock.on(ScanCommand).resolves({ Items: rows });
    stubPartition(ORG_ID, rows);

    await handler();

    expect(updateInputs()).toEqual([
      {
        TableName: 'OrgTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'META' } },
        UpdateExpression: 'SET ownerCount = :counted',
        ConditionExpression: 'ownerCount = :stale AND ownerSetRev = :rev',
        ExpressionAttributeValues: {
          ':counted': { N: '1' },
          ':stale': { N: '3' },
          ':rev': { N: '7' },
        },
      },
    ]);
  });

  it('holds a transfer that commits between the member pages against the revision it started from', async () => {
    // The real ordering, simulated: `MEMBER#` sorts before `META`, so a paged
    // partition delivers the counter last. Page one still shows the outgoing
    // Owner; a transfer commits; page two shows the incoming one, and the META
    // row that arrives with it already carries the moved revision. Counted two
    // Owners for an org that has one — and a repair written against revision 8
    // would be accepted, inflating the counter and defeating the
    // `ownerCount > :one` last-Owner guard.
    //
    // The recount reads the counter before it pages anything, so the write is
    // conditioned on revision 7 and DynamoDB refuses it. The META row on page
    // two is exactly what must not win.
    ddbMock.on(ScanCommand).resolves({
      Items: [metaRow(ORG_ID, 1, 7), memberRow(ORG_ID, 'user-1'), memberRow(ORG_ID, 'user-2')],
    });
    stubOrgMeta(ORG_ID, metaRow(ORG_ID, 1, 7));
    stubMemberPages(ORG_ID)
      .resolvesOnce({
        Items: [memberRow(ORG_ID, 'user-1')] as never,
        LastEvaluatedKey: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'MEMBER#user-1' } },
      })
      .resolvesOnce({
        Items: [memberRow(ORG_ID, 'user-2'), metaRow(ORG_ID, 1, 8)] as never,
      });
    ddbMock
      .on(UpdateItemCommand)
      .rejects(
        new ConditionalCheckFailedException({ message: 'the revision moved', $metadata: {} }),
      );

    await handler();

    expect(updateInputs()).toEqual([
      {
        TableName: 'OrgTable',
        Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'META' } },
        UpdateExpression: 'SET ownerCount = :counted',
        ConditionExpression: 'ownerCount = :stale AND ownerSetRev = :rev',
        ExpressionAttributeValues: {
          ':counted': { N: '2' },
          ':stale': { N: '1' },
          ':rev': { N: '7' },
        },
      },
    ]);
    // Not a failure: the counter is whatever the transfer left, and the next run
    // recounts an org nothing is changing under it.
    expect(logsMatching(logSpy, 'repair skipped, the counter moved')).toHaveLength(1);
    expect(logsMatching(errorSpy, 'repair failed')).toHaveLength(0);
    expect(repairsEmitted(stdoutSpy)).toBe(0);
  });

  it('reads the counter before the first member page', async () => {
    const rows = [metaRow(ORG_ID, 3, 7), memberRow(ORG_ID, 'user-1')];
    ddbMock.on(ScanCommand).resolves({ Items: rows });
    stubPartition(ORG_ID, rows);

    await handler();

    // Ordering is the fix, so it is asserted rather than inferred from the
    // condition: a counter read after the pages dates to the end of an interval
    // it is supposed to cover.
    const commands = ddbMock.calls().map((call) => (call.args[0] as object).constructor.name);
    expect(commands.indexOf('GetItemCommand')).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('GetItemCommand')).toBeLessThan(commands.indexOf('QueryCommand'));
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
