import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { S3Region } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
    RagIndexerTable: { name: 'RagIndexerTable' },
    RagVectorBucket: { name: 'rag-vectors' },
    OrgTable: { name: 'OrgTable' },
    AuditLog: { name: 'AuditTable' },
  },
}));

const mockDropIndex = vi.fn(async () => undefined);
vi.mock('@filone/rag-shared', () => ({
  S3VectorsStore: class {
    dropIndex = (...args: unknown[]) => mockDropIndex(...(args as []));
  },
}));

const mockLoadManifest = vi.fn(async () => new Map<string, unknown>());
const mockDeleteManifestEntry = vi.fn(async () => undefined);
const mockClearCheckpoint = vi.fn(async () => undefined);
vi.mock('../jobs/rag-indexer-manifest.ts', () => ({
  loadManifest: () => mockLoadManifest(),
  deleteManifestEntry: (...args: unknown[]) => mockDeleteManifestEntry(...(args as [])),
  clearCheckpoint: (...args: unknown[]) => mockClearCheckpoint(...(args as [])),
}));

const ddbMock = mockClient(DynamoDBClient);

import { moveSurvivingMembers, scrubOrgRecords } from './deletion-scrub.ts';
import type { DeletionMember } from './deletion-record.ts';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const MEMBERS: DeletionMember[] = [{ userId: 'user-1', sub: 'auth0|one', deleteIdentity: true }];

/** Every key passed to DeleteItem, in call order, as `table:pk/sk`. */
function deletedKeys(): string[] {
  return ddbMock.commandCalls(DeleteItemCommand).map((call) => {
    const { TableName, Key } = call.args[0].input;
    return `${TableName}:${Key!.pk!.S}/${Key!.sk!.S}`;
  });
}

function updateKey(input: { TableName?: string; Key?: Record<string, { S?: string }> }): string {
  return `${input.TableName}:${input.Key!.pk!.S}/${input.Key!.sk!.S}`;
}

/** Every key passed to UpdateItem, in call order, as `table:pk/sk`. */
function scrubbedKeys(): string[] {
  return ddbMock.commandCalls(UpdateItemCommand).map((call) => updateKey(call.args[0].input));
}

/** The scrub of one row, addressed the same way scrubbedKeys reports it. */
function scrubOf(key: string) {
  return ddbMock.commandCalls(UpdateItemCommand).find((c) => updateKey(c.args[0].input) === key)!
    .args[0].input;
}

/** Every survivor repoint the move sent, as `pk/sk -> orgId`. */
function repoints(): string[] {
  return ddbMock
    .commandCalls(TransactWriteItemsCommand)
    .flatMap((call) => call.args[0].input.TransactItems ?? [])
    .flatMap((item) => (item.Update?.UpdateExpression === 'SET orgId = :home' ? [item.Update] : []))
    .map(({ Key, ExpressionAttributeValues }) => {
      return `${Key!.pk!.S}/${Key!.sk!.S} -> ${ExpressionAttributeValues![':home']!.S}`;
    });
}

/** A repoint transaction cancelled at `index`: 0 is the destination's fence, 1 the row. */
function repointCancelledAt(index: 0 | 1) {
  const reasons = [{ Code: 'None' }, { Code: 'None' }];
  reasons[index] = { Code: 'ConditionalCheckFailed' };
  return new TransactionCanceledException({
    message: 'cancelled',
    $metadata: {},
    CancellationReasons: reasons,
  });
}

/** Every command the scrub sent, in order, with its name and its input. */
function callOrder(): { name: string; input: Record<string, unknown> }[] {
  return ddbMock.calls().map((call) => {
    const command = call.args[0] as unknown as {
      constructor: { name: string };
      input: Record<string, unknown>;
    };
    return { name: command.constructor.name, input: command.input };
  });
}

function orgRow(sk: string, extra: Record<string, unknown> = {}) {
  return marshall({ pk: `ORG#${ORG}`, sk, ...extra });
}

/** No rows anywhere unless a test says otherwise. */
function stubEmpty() {
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(ScanCommand).resolves({ Items: [] });
  ddbMock.on(DeleteItemCommand).resolves({});
  ddbMock.on(UpdateItemCommand).resolves({});
}

describe('scrubOrgRecords', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    mockLoadManifest.mockResolvedValue(new Map());
    stubEmpty();
  });

  it('destroys credentials and keeps every row that describes the org', async () => {
    ddbMock.on(QueryCommand, { TableName: 'UserInfoTable' }).resolves({
      Items: [
        orgRow('DELETION'),
        orgRow('PROFILE'),
        orgRow('MEMBER#user-1'),
        orgRow('ACCESSKEY#ak-1'),
        orgRow('RAGKEY#key-1', { tokenHash: 'hash-1' }),
      ],
    });

    await scrubOrgRecords(ORG, MEMBERS);

    expect(deletedKeys()).toEqual([
      'UserInfoTable:RAGKEYHASH#hash-1/LOOKUP',
      `UserInfoTable:ORG#${ORG}/ACCESSKEY#ak-1`,
      `UserInfoTable:ORG#${ORG}/RAGKEY#key-1`,
      'UserInfoTable:USER#user-1/AVATAR_UPLOAD_RATE',
      // The member's inverse item, from the member list rather than the OrgTable
      // partition: it is the row that would otherwise leave them holding a
      // membership in an org that is gone.
      `OrgTable:USER#user-1/MEMBERSHIP#${ORG}`,
    ]);
    const kept = scrubbedKeys();
    expect(kept).toContain(`UserInfoTable:ORG#${ORG}/MEMBER#user-1`);
    // Last: it holds the tenant ids a resumed pass reads.
    expect(kept.at(-1)).toBe(`UserInfoTable:ORG#${ORG}/PROFILE`);
  });

  // Destroyed rather than stamped: an event's personal data is in the row body,
  // so emptying it would mean rewriting stored history.
  it('destroys the org audit partition', async () => {
    ddbMock.on(QueryCommand, { TableName: 'AuditTable' }).resolves({
      Items: [
        marshall({ pk: `ORG#${ORG}`, sk: '2026-08-27T10:00:00.000Z#event-1' }),
        marshall({ pk: `ORG#${ORG}`, sk: '2026-08-28T10:00:00.000Z#event-2' }),
      ],
    });

    await scrubOrgRecords(ORG, MEMBERS);

    expect(deletedKeys()).toEqual([
      'UserInfoTable:USER#user-1/AVATAR_UPLOAD_RATE',
      `AuditTable:ORG#${ORG}/2026-08-27T10:00:00.000Z#event-1`,
      `AuditTable:ORG#${ORG}/2026-08-28T10:00:00.000Z#event-2`,
      `OrgTable:USER#user-1/MEMBERSHIP#${ORG}`,
    ]);
    expect(scrubbedKeys()).not.toContain(`AuditTable:ORG#${ORG}/2026-08-27T10:00:00.000Z#event-1`);
  });

  it('strips the name and logo off the org profile and leaves the fence up', async () => {
    await scrubOrgRecords(ORG, MEMBERS);

    const update = scrubOf(`UserInfoTable:ORG#${ORG}/PROFILE`);
    expect(update.UpdateExpression).toBe(
      'SET deletedAt = if_not_exists(deletedAt, :now) REMOVE #name, logoUrl',
    );
    expect(update.ExpressionAttributeNames).toEqual({ '#name': 'name' });
    expect(update.ConditionExpression).toBe('attribute_exists(pk)');
  });

  // A lookup pk derives from the tokenHash on the RAGKEY# row, so deleting the
  // partition first would leave rows nothing can ever find again.
  it('deletes RAG key lookup rows before the partition that names them', async () => {
    ddbMock.on(QueryCommand, { TableName: 'UserInfoTable' }).resolves({
      Items: [orgRow('RAGKEY#key-1', { tokenHash: 'hash-1' }), orgRow('MEMBER#user-1')],
    });

    await scrubOrgRecords(ORG, MEMBERS);

    const keys = deletedKeys();
    const lookup = keys.indexOf('UserInfoTable:RAGKEYHASH#hash-1/LOOKUP');
    const ragKey = keys.indexOf(`UserInfoTable:ORG#${ORG}/RAGKEY#key-1`);
    expect(lookup).toBeGreaterThanOrEqual(0);
    expect(lookup).toBeLessThan(ragKey);
  });

  // Emptying the row would break auth: it branches on the row holding both ids,
  // and without them a live JWT takes the new-user path and mints a fresh org.
  it('stamps the identity row without touching userId or orgId', async () => {
    await scrubOrgRecords(ORG, MEMBERS);

    expect(scrubOf('UserInfoTable:SUB#auth0|one/IDENTITY').UpdateExpression).toBe(
      'SET deletedAt = if_not_exists(deletedAt, :now)',
    );
  });

  // An overlapping pass finishes and marks the deletion done; an invitation then
  // replaces the identity with a new userId under the same sub. This pass's
  // stamp must not land on that new account.
  it('stamps the identity row only while it still names the deleted userId', async () => {
    await scrubOrgRecords(ORG, MEMBERS);

    expect(scrubOf('UserInfoTable:SUB#auth0|one/IDENTITY')).toMatchObject({
      ConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': { S: 'user-1' } },
    });
  });

  it('stamps every row that survives, and deletes only the avatar rate limit rows', async () => {
    await scrubOrgRecords(ORG, [
      { userId: 'user-1', sub: 'auth0|one', deleteIdentity: true },
      { userId: 'user-2', sub: 'auth0|two', deleteIdentity: true },
    ]);

    expect(scrubbedKeys()).toEqual([
      `BillingTable:ORG#${ORG}/SUBSCRIPTION`,
      'UserInfoTable:SUB#auth0|one/IDENTITY',
      'UserInfoTable:USER#user-1/PROFILE',
      `UserInfoTable:ORG#${ORG}/MEMBER#user-1`,
      'UserInfoTable:SUB#auth0|two/IDENTITY',
      'UserInfoTable:USER#user-2/PROFILE',
      `UserInfoTable:ORG#${ORG}/MEMBER#user-2`,
      `UserInfoTable:ORG#${ORG}/PROFILE`,
    ]);
    expect(deletedKeys().filter((key) => key.startsWith('UserInfoTable:'))).toEqual([
      'UserInfoTable:USER#user-1/AVATAR_UPLOAD_RATE',
      'UserInfoTable:USER#user-2/AVATAR_UPLOAD_RATE',
    ]);
  });

  // The worker writes `canceled` itself, after the Stripe cancel has succeeded, so
  // the row and Stripe cannot disagree whatever order the webhooks arrive in.
  it('strips the card fields off the org billing row and cancels it', async () => {
    await scrubOrgRecords(ORG, MEMBERS);

    const update = scrubOf(`BillingTable:ORG#${ORG}/SUBSCRIPTION`);
    expect(update.TableName).toBe('BillingTable');
    expect(update.UpdateExpression).toBe(
      'SET deletedAt = if_not_exists(deletedAt, :now), ' +
        'subscriptionStatus = :canceled, updatedAt = :now ' +
        'REMOVE paymentMethodId, paymentMethodLast4, paymentMethodBrand, ' +
        'paymentMethodExpMonth, paymentMethodExpYear, gracePeriodEndsAt',
    );
    expect(update.ExpressionAttributeValues![':canceled']).toEqual({ S: 'canceled' });
  });

  // A financial record with no personal data, on its own TTL.
  it('leaves the usage audit rows alone', async () => {
    ddbMock
      .on(QueryCommand, { TableName: 'BillingTable' })
      .resolves({ Items: [marshall({ pk: `ORG#${ORG}`, sk: 'USAGE_REPORT#2026-08-01' })] });

    await scrubOrgRecords(ORG, MEMBERS);

    expect(deletedKeys()).not.toContain(`BillingTable:ORG#${ORG}/USAGE_REPORT#2026-08-01`);
    expect(scrubbedKeys()).not.toContain(`BillingTable:ORG#${ORG}/USAGE_REPORT#2026-08-01`);
  });

  // A member who never onboarded has no billing row, and a bare UpdateItem would
  // upsert one holding nothing but a stamp.
  it('does not recreate a row that is not there', async () => {
    ddbMock
      .on(UpdateItemCommand)
      .rejects(new ConditionalCheckFailedException({ $metadata: {}, message: 'nope' }));

    await expect(scrubOrgRecords(ORG, MEMBERS)).resolves.toBeUndefined();
  });

  describe('RAG state', () => {
    const BUCKET_PK = `BUCKET#${ORG}#${S3Region.EuWest1}#docs`;

    it('purges manifests, the enablement row, the checkpoint and the vector index', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [marshall({ pk: BUCKET_PK })] });
      mockLoadManifest.mockResolvedValue(new Map([['reports/q1.pdf', {}]]));

      await scrubOrgRecords(ORG, MEMBERS);

      expect(mockDeleteManifestEntry).toHaveBeenCalledWith(
        ORG,
        S3Region.EuWest1,
        'docs',
        'reports/q1.pdf',
      );
      expect(deletedKeys()).toContain(`RagIndexerTable:${BUCKET_PK}/RAG`);
      expect(mockClearCheckpoint).toHaveBeenCalledWith(ORG, S3Region.EuWest1, 'docs');
      expect(mockDropIndex).toHaveBeenCalledWith(ORG, S3Region.EuWest1, 'docs');
    });

    // The sk is rebuilt by the same builder that wrote it, so a '#' in the key
    // cannot be mangled by a split.
    it('handles an objectKey containing the key delimiter', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [marshall({ pk: BUCKET_PK })] });
      mockLoadManifest.mockResolvedValue(new Map([['odd#name#2.pdf', {}]]));

      await scrubOrgRecords(ORG, MEMBERS);

      expect(mockDeleteManifestEntry).toHaveBeenCalledWith(
        ORG,
        S3Region.EuWest1,
        'docs',
        'odd#name#2.pdf',
      );
    });

    it('purges a bucket known only from its checkpoint row, exactly once', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          marshall({ pk: BUCKET_PK }),
          marshall({ pk: `INDEXER_CHECKPOINT#${ORG}#${S3Region.EuWest1}#docs` }),
        ],
      });

      await scrubOrgRecords(ORG, MEMBERS);

      expect(mockDropIndex).toHaveBeenCalledTimes(1);
      expect(mockClearCheckpoint).toHaveBeenCalledTimes(1);
    });

    it('scans only this org, for both pk shapes', async () => {
      await scrubOrgRecords(ORG, MEMBERS);

      const scan = ddbMock.commandCalls(ScanCommand)[0]!.args[0].input;
      expect(scan.FilterExpression).toBe(
        'begins_with(pk, :bucket) OR begins_with(pk, :checkpoint)',
      );
      expect(scan.ExpressionAttributeValues).toEqual(
        marshall({ ':bucket': `BUCKET#${ORG}#`, ':checkpoint': `INDEXER_CHECKPOINT#${ORG}#` }),
      );
    });
  });

  describe('the OrgTable rows', () => {
    function orgTableRow(sk: string, extra: Record<string, unknown> = {}) {
      return marshall({ pk: `ORG#${ORG}`, sk, ...extra });
    }

    function stubOrgTable(items: ReturnType<typeof orgTableRow>[]) {
      ddbMock.on(QueryCommand, { TableName: 'OrgTable' }).resolves({ Items: items });
    }

    // Nothing else removes them, and a membership left behind leaves its member
    // able to act in an org that no longer exists.
    it('destroys every row the org owns, and the members last', async () => {
      stubOrgTable([
        orgTableRow('META'),
        orgTableRow('MEMBER#user-1'),
        orgTableRow('INVITE#invite-1', { tokenHash: 'invite-hash' }),
        orgTableRow('RESERVATION#acme'),
      ]);

      await scrubOrgRecords(ORG, MEMBERS);

      expect(deletedKeys().filter((key) => key.startsWith('OrgTable:'))).toEqual([
        'OrgTable:INVITETOKEN#invite-hash/LOOKUP',
        `OrgTable:ORG#${ORG}/META`,
        `OrgTable:ORG#${ORG}/INVITE#invite-1`,
        `OrgTable:ORG#${ORG}/RESERVATION#acme`,
        `OrgTable:USER#user-1/MEMBERSHIP#${ORG}`,
        `OrgTable:ORG#${ORG}/MEMBER#user-1`,
      ]);
    });

    // Membership rows are what a re-driven pass resolves its members from, so a
    // pass that dies before them still knows who to tear down.
    it('deletes the membership row after everything it addresses', async () => {
      stubOrgTable([orgTableRow('MEMBER#user-1'), orgTableRow('META')]);

      await scrubOrgRecords(ORG, MEMBERS);

      const keys = deletedKeys();
      expect(keys.at(-1)).toBe(`OrgTable:ORG#${ORG}/MEMBER#user-1`);
    });

    // The census parses this key rather than slicing it, and the two readers of
    // the same key shape have to agree — an empty id addresses `USER#`, which
    // belongs to nobody.
    it('derives no inverse item from a member row with no user id', async () => {
      stubOrgTable([orgTableRow('MEMBER#'), orgTableRow('MEMBER#user-1')]);

      await scrubOrgRecords(ORG, MEMBERS);

      expect(deletedKeys()).not.toContain(`OrgTable:USER#/MEMBERSHIP#${ORG}`);
      // The malformed row is still the org's, and still goes.
      expect(deletedKeys()).toContain(`OrgTable:ORG#${ORG}/MEMBER#`);
    });

    it('deletes the inverse item of a member the OrgTable partition does not name', async () => {
      stubOrgTable([]);

      await scrubOrgRecords(ORG, MEMBERS);

      expect(deletedKeys()).toContain(`OrgTable:USER#user-1/MEMBERSHIP#${ORG}`);
    });

    // Every step that reads a member has to be able to run again on a re-drive,
    // and these rows are what a re-drive resolves those members from.
    it('destroys them after the last member-independent step', async () => {
      stubOrgTable([orgTableRow('MEMBER#user-1'), orgTableRow('META')]);

      await scrubOrgRecords(ORG, MEMBERS);

      const calls = callOrder();
      const profileScrubbed = calls.findIndex(
        (c) =>
          c.name === 'UpdateItemCommand' &&
          (c.input.Key as Record<string, { S: string }>).sk?.S === 'PROFILE' &&
          (c.input.Key as Record<string, { S: string }>).pk?.S === `ORG#${ORG}`,
      );
      const firstDestroyed = calls.findIndex(
        (c) => c.name === 'DeleteItemCommand' && c.input.TableName === 'OrgTable',
      );
      expect(profileScrubbed).toBeGreaterThanOrEqual(0);
      expect(firstDestroyed).toBeGreaterThan(profileScrubbed);
    });

    it('reads the partition consistently, and by pk alone', async () => {
      await scrubOrgRecords(ORG, MEMBERS);

      const query = ddbMock
        .commandCalls(QueryCommand)
        .find((c) => c.args[0].input.TableName === 'OrgTable')!.args[0].input;
      expect(query.KeyConditionExpression).toBe('pk = :pk');
      expect(query.ConsistentRead).toBe(true);
    });

    // The lookup pk derives from the tokenHash on the invitation row, the same
    // ordering the RAG key lookups need.
    it('deletes an invite token lookup before the invitation that names it', async () => {
      stubOrgTable([orgTableRow('INVITE#invite-1', { tokenHash: 'invite-hash' })]);

      await scrubOrgRecords(ORG, MEMBERS);

      const keys = deletedKeys();
      expect(keys.indexOf('OrgTable:INVITETOKEN#invite-hash/LOOKUP')).toBeLessThan(
        keys.indexOf(`OrgTable:ORG#${ORG}/INVITE#invite-1`),
      );
    });

    // No TTL on OrgTable and no expiry sweep: the lookup row simply stays.
    it('leaves the lookup row in place when an invitation stores no token hash', async () => {
      stubOrgTable([orgTableRow('INVITE#invite-1')]);

      await scrubOrgRecords(ORG, MEMBERS);

      expect(deletedKeys().some((key) => key.includes('INVITETOKEN#'))).toBe(false);
    });
  });

  describe('a member whose account outlives the org', () => {
    const KEPT: DeletionMember[] = [
      { userId: 'user-1', sub: 'auth0|one', deleteIdentity: false },
      { userId: 'user-2', sub: 'auth0|two', deleteIdentity: true },
    ];

    it('keeps their identity and profile rows unstamped', async () => {
      await scrubOrgRecords(ORG, KEPT);

      const kept = scrubbedKeys();
      expect(kept).not.toContain('UserInfoTable:SUB#auth0|one/IDENTITY');
      expect(kept).not.toContain('UserInfoTable:USER#user-1/PROFILE');
      expect(kept).toContain('UserInfoTable:SUB#auth0|two/IDENTITY');
      expect(kept).toContain('UserInfoTable:USER#user-2/PROFILE');
    });

    it('still stamps their membership row and deletes their OrgTable rows', async () => {
      await scrubOrgRecords(ORG, KEPT);

      expect(scrubbedKeys()).toContain(`UserInfoTable:ORG#${ORG}/MEMBER#user-1`);
      expect(deletedKeys()).toContain(`OrgTable:USER#user-1/MEMBERSHIP#${ORG}`);
    });

    // The move runs at the start of the pass, so the scrub at its end leaves
    // survivors' home rows as it finds them.
    it('leaves moving a survivor to the start of the pass', async () => {
      await scrubOrgRecords(ORG, [
        { userId: 'user-1', sub: 'auth0|one', deleteIdentity: false, homeOrgId: OTHER_ORG },
      ]);

      expect(repoints()).toEqual([]);
      expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toStrictEqual([]);
    });

    describe('moving off the org at the start of the pass', () => {
      // Both rows name the org auth fences every request on, before any X-Org-Id
      // is read. Left naming this one, the survivor is refused forever.
      it('re-points the survivor at the org they still belong to', async () => {
        await moveSurvivingMembers(ORG, [
          { userId: 'user-1', sub: 'auth0|one', deleteIdentity: false, homeOrgId: OTHER_ORG },
          ...KEPT.slice(1),
        ]);

        expect(repoints()).toEqual([
          `SUB#auth0|one/IDENTITY -> ${OTHER_ORG}`,
          `USER#user-1/PROFILE -> ${OTHER_ORG}`,
        ]);
      });

      describe('with no other org to move to', () => {
        const STRANDED: DeletionMember[] = [
          { userId: 'user-1', sub: 'auth0|one', deleteIdentity: false, needsFloorOrg: true },
        ];

        /** The org each of the member's two home rows names when the move reads them. */
        function stubHome({ profile, identity }: { profile?: string; identity?: string }) {
          ddbMock
            .on(GetItemCommand, {
              TableName: 'UserInfoTable',
              Key: { pk: { S: 'USER#user-1' }, sk: { S: 'PROFILE' } },
            })
            .resolves({
              Item: { sub: { S: 'auth0|one' }, ...(profile ? { orgId: { S: profile } } : {}) },
            });
          ddbMock
            .on(GetItemCommand, {
              TableName: 'UserInfoTable',
              Key: { pk: { S: 'SUB#auth0|one' }, sk: { S: 'IDENTITY' } },
            })
            .resolves({ Item: identity ? { orgId: { S: identity } } : {} });
        }

        function repointCancelled() {
          return new TransactionCanceledException({
            message: 'cancelled',
            $metadata: {},
            CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
          });
        }

        function floorOrgItems() {
          const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
          expect(calls).toHaveLength(1);
          return calls[0]!.args[0].input.TransactItems!;
        }

        it('moves them onto a floor org of their own, while their home still names the deleting org', async () => {
          stubHome({ profile: ORG, identity: ORG });

          await moveSurvivingMembers(ORG, STRANDED);

          const items = floorOrgItems();
          const profile = items.find((item) => item.Put?.Item?.sk?.S === 'PROFILE')!.Put!.Item!;
          const floorOrgId = profile.pk!.S!.slice('ORG#'.length);
          expect(profile).toMatchObject({ floorOrg: { BOOL: true } });
          expect(
            items.find((item) => item.Update?.Key?.pk?.S === 'SUB#auth0|one')?.Update,
          ).toMatchObject({
            ConditionExpression: 'attribute_exists(pk) AND orgId = :expected',
            ExpressionAttributeValues: { ':orgId': { S: floorOrgId }, ':expected': { S: ORG } },
          });
          expect(
            items.find((item) => item.Update?.Key?.pk?.S === 'USER#user-1')?.Update,
          ).toMatchObject({
            ExpressionAttributeValues: { ':orgId': { S: floorOrgId }, ':expected': { S: ORG } },
          });
        });

        it('moves a profile that names another org along with the identity', async () => {
          stubHome({ profile: 'any-stale-org', identity: ORG });

          await moveSurvivingMembers(ORG, STRANDED);

          expect(
            floorOrgItems().find((item) => item.Update?.Key?.pk?.S === 'USER#user-1')?.Update,
          ).toMatchObject({ ExpressionAttributeValues: { ':expected': { S: 'any-stale-org' } } });
        });

        // A re-drive, or an overlapping pass that moved them first.
        it('writes nothing, quietly, when their home has moved already', async () => {
          stubHome({ profile: ORG, identity: 'any-floor-org' });
          ddbMock.on(TransactWriteItemsCommand).rejects(repointCancelled());
          const error = vi.spyOn(console, 'error').mockImplementation(() => {});

          await expect(moveSurvivingMembers(ORG, STRANDED)).resolves.toBeUndefined();
          expect(error).not.toHaveBeenCalled();
        });

        it('logs an error when the move failed and their home still names the deleting org', async () => {
          stubHome({ profile: ORG, identity: ORG });
          ddbMock.on(TransactWriteItemsCommand).rejects(repointCancelled());
          const error = vi.spyOn(console, 'error').mockImplementation(() => {});

          await moveSurvivingMembers(ORG, STRANDED);

          expect(error).toHaveBeenCalledWith(
            expect.stringContaining('Floor org not written'),
            expect.objectContaining({ orgId: ORG, userId: 'user-1' }),
          );
        });

        it('fails the pass, to be retried, when their profile cannot be read', async () => {
          ddbMock
            .on(GetItemCommand, {
              TableName: 'UserInfoTable',
              Key: { pk: { S: 'USER#user-1' }, sk: { S: 'PROFILE' } },
            })
            .rejects(new Error('any-read-failure'));

          await expect(moveSurvivingMembers(ORG, STRANDED)).rejects.toThrow('any-read-failure');
          expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toStrictEqual([]);
        });

        it('fails the pass, to be retried, when the floor org cannot be written', async () => {
          stubHome({ profile: ORG, identity: ORG });
          ddbMock.on(TransactWriteItemsCommand).rejects(new Error('any-throttle'));

          await expect(moveSurvivingMembers(ORG, STRANDED)).rejects.toThrow('any-throttle');
        });
      });

      it('conditions the move on the row still naming the deleting org, and on the destination not being deleted', async () => {
        await moveSurvivingMembers(ORG, [
          { userId: 'user-1', sub: 'auth0|one', deleteIdentity: false, homeOrgId: OTHER_ORG },
        ]);

        const [fence, move] =
          ddbMock.commandCalls(TransactWriteItemsCommand)[0]!.args[0].input.TransactItems!;
        expect(fence).toMatchObject({
          ConditionCheck: {
            Key: { pk: { S: `ORG#${OTHER_ORG}` }, sk: { S: 'PROFILE' } },
            ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleting)',
          },
        });
        expect(move!.Update).toMatchObject({
          ConditionExpression: 'attribute_exists(pk) AND orgId = :deleting',
          ExpressionAttributeValues: { ':deleting': { S: ORG } },
        });
      });

      // The second pass finds rows that already moved, so the condition loses.
      it('is a no-op on a re-drive', async () => {
        ddbMock.on(TransactWriteItemsCommand).rejects(repointCancelledAt(1));

        await expect(
          moveSurvivingMembers(ORG, [
            { userId: 'user-1', sub: 'auth0|one', deleteIdentity: false, homeOrgId: OTHER_ORG },
          ]),
        ).resolves.toBeUndefined();
        expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(2);
      });

      // Confirmed after the census read it as live: two orgs deleted together.
      it('moves the survivor onto a floor org when the org chosen for them is being deleted by the time they move', async () => {
        ddbMock.on(GetItemCommand).resolves({
          Item: { sub: { S: 'auth0|one' }, orgId: { S: ORG } },
        });
        ddbMock.on(TransactWriteItemsCommand).rejectsOnce(repointCancelledAt(0)).resolves({});

        await moveSurvivingMembers(ORG, [
          { userId: 'user-1', sub: 'auth0|one', deleteIdentity: false, homeOrgId: OTHER_ORG },
        ]);

        expect(repoints()).toEqual([`SUB#auth0|one/IDENTITY -> ${OTHER_ORG}`]);
        const floorOrg =
          ddbMock.commandCalls(TransactWriteItemsCommand)[1]!.args[0].input.TransactItems!;
        expect(floorOrg).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              Put: expect.objectContaining({
                Item: expect.objectContaining({ floorOrg: { BOOL: true } }),
              }),
            }),
          ]),
        );
      });

      // Nowhere to send them: the account survives, pointing at a deleted org.
      it('leaves the rows alone when the member has no other org', async () => {
        await moveSurvivingMembers(ORG, KEPT);

        expect(repoints()).toEqual([]);
      });

      it('leaves the rows of a member whose account is ending alone', async () => {
        await moveSurvivingMembers(ORG, MEMBERS);

        expect(repoints()).toEqual([]);
      });
    });

    // Every deletion fences the org's own row, whoever the members are.
    it('still stamps the org billing row', async () => {
      await scrubOrgRecords(ORG, KEPT);

      expect(scrubbedKeys()).toContain(`BillingTable:ORG#${ORG}/SUBSCRIPTION`);
    });
  });

  it('pages the org partition, threading the cursor back through', async () => {
    const cursor = marshall({ pk: `ORG#${ORG}`, sk: 'ACCESSKEY#ak-1' });
    ddbMock
      .on(QueryCommand, { TableName: 'UserInfoTable' })
      .resolvesOnce({ Items: [orgRow('ACCESSKEY#ak-1')], LastEvaluatedKey: cursor })
      .resolves({ Items: [orgRow('ACCESSKEY#ak-2')] });

    await scrubOrgRecords(ORG, MEMBERS);

    const queries = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.TableName === 'UserInfoTable');
    expect(queries).toHaveLength(2);
    expect(queries[1]!.args[0].input.ExclusiveStartKey).toEqual(cursor);
    expect(deletedKeys()).toContain(`UserInfoTable:ORG#${ORG}/ACCESSKEY#ak-2`);
  });

  // A re-drive after a completed pass: the credentials are already gone, and the
  // stamps land again on rows that keep the first pass's time.
  it('is a clean no-op on a second pass', async () => {
    ddbMock
      .on(QueryCommand, { TableName: 'UserInfoTable' })
      .resolves({ Items: [orgRow('DELETION'), orgRow('PROFILE'), orgRow('MEMBER#user-1')] });

    await expect(scrubOrgRecords(ORG, MEMBERS)).resolves.toBeUndefined();

    // Deleting a row that is already gone is a no-op.
    expect(deletedKeys()).toEqual([
      'UserInfoTable:USER#user-1/AVATAR_UPLOAD_RATE',
      `OrgTable:USER#user-1/MEMBERSHIP#${ORG}`,
    ]);
    for (const call of ddbMock.commandCalls(UpdateItemCommand)) {
      expect(call.args[0].input.UpdateExpression).toContain('if_not_exists(deletedAt, :now)');
    }
  });
});
