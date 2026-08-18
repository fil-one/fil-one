import { describe, expect, it } from 'vitest';
import type { AttributeValue, TransactWriteItem } from '@aws-sdk/client-dynamodb';

// The canonical sources this file's mirror copies. A bin script cannot import
// either at runtime (Node's type stripping resolves neither the backend's
// `./x.js` specifiers nor the `OrgRole` enum), but vitest resolves both — so
// the mirror is held to them here rather than by hand.
import { OrgRole } from '@filone/shared';
import { OrgKeys as BackendOrgKeys } from '@filone/backend/src/lib/org-membership.js';

import { classifyCancellation } from './dynamo.ts';
import {
  buildConversionTransactItems,
  buildRevertTransactItems,
  classifyOrg,
  CONVERSION_SOURCE,
  CONVERTED_ROLE,
  formatPlanReport,
  legacyMemberKey,
  LEGACY_ROLE,
  OrgKeys,
  parseMemberSk,
  parseMembershipSk,
  parseOrgPk,
  parseUserPk,
  summarizePlans,
  UNKNOWN_JOINED_AT,
  willRevert,
} from './org-conversion.ts';
import type {
  ConvertedMembership,
  ConvertPlan,
  MembershipScan,
  OrgPlan,
  OrgState,
  ScanCounts,
  ScanResult,
} from './org-conversion.ts';
import { formatVerifyReport, parseAcceptedAnomalies, verifyConversion } from './org-verify.ts';

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_USER_ID = '99999999-8888-7777-6666-555555555555';
const JOINED_AT = '2026-01-01T00:00:00.000Z';
const CREATED_AT = '2025-11-02T12:00:00.000Z';
const ORG_TABLE = 'OrgTable';
const USER_INFO_TABLE = 'UserInfoTable';

const knownUsers = new Set([USER_ID, OTHER_USER_ID]);

function state(overrides: Partial<OrgState> = {}): OrgState {
  return {
    orgId: ORG_ID,
    profile: { createdBy: USER_ID, createdAt: CREATED_AT },
    legacyMembers: [],
    orgTableMemberUserIds: [],
    hasMeta: false,
    ...overrides,
  };
}

function legacyMember(overrides: Partial<{ userId: string; role: string; joinedAt: string }> = {}) {
  return { userId: USER_ID, role: LEGACY_ROLE, joinedAt: JOINED_AT, ...overrides };
}

function convertPlan(overrides: Partial<ConvertPlan> = {}): ConvertPlan {
  return {
    kind: 'convert',
    orgId: ORG_ID,
    userId: USER_ID,
    joinedAt: JOINED_AT,
    origin: 'member-row',
    legacyRow: true,
    metaExists: false,
    ...overrides,
  };
}

/** Asserts a transaction item is a Put and hands back the Put, so nothing passes vacuously. */
function putOf(item: TransactWriteItem | undefined) {
  expect(item?.Put).toBeDefined();
  return item!.Put!;
}

/** Asserts a transaction item is a Delete and hands back the Delete. */
function deleteOf(item: TransactWriteItem | undefined) {
  expect(item?.Delete).toBeDefined();
  return item!.Delete!;
}

describe('the mirrored definitions', () => {
  // These four values are copied out of packages/ because a bin script cannot
  // import them. If one of these fails, the copy in org-conversion.ts is stale
  // and the conversion is writing something the backend does not read.
  it('carries the same role values as @filone/shared', () => {
    expect(CONVERTED_ROLE).toBe(OrgRole.Owner);
    expect(LEGACY_ROLE).toBe(OrgRole.Admin);
    expect(CONVERTED_ROLE).not.toBe(LEGACY_ROLE);
  });

  it('builds the same keys as the backend', () => {
    expect(OrgKeys.orgPk(ORG_ID)).toBe(BackendOrgKeys.orgPk(ORG_ID));
    expect(OrgKeys.memberSk(USER_ID)).toBe(BackendOrgKeys.memberSk(USER_ID));
    expect(OrgKeys.memberSkPrefix()).toBe(BackendOrgKeys.memberSkPrefix());
    expect(OrgKeys.orgMetaSk()).toBe(BackendOrgKeys.orgMetaSk());
    expect(OrgKeys.userPk(USER_ID)).toBe(BackendOrgKeys.userPk(USER_ID));
    expect(OrgKeys.membershipSk(ORG_ID)).toBe(BackendOrgKeys.membershipSk(ORG_ID));
    expect(OrgKeys.membershipSkPrefix()).toBe(BackendOrgKeys.membershipSkPrefix());
  });

  it('writes an inverse item the backend can parse back', () => {
    expect(BackendOrgKeys.parseMembershipSk(OrgKeys.membershipSk(ORG_ID))).toBe(ORG_ID);
  });
});

describe('key builders', () => {
  it('builds the row shapes the backend reads', () => {
    expect(OrgKeys.orgPk(ORG_ID)).toBe(`ORG#${ORG_ID}`);
    expect(OrgKeys.memberSk(USER_ID)).toBe(`MEMBER#${USER_ID}`);
    expect(OrgKeys.memberSkPrefix()).toBe('MEMBER#');
    expect(OrgKeys.orgMetaSk()).toBe('META');
    expect(OrgKeys.userPk(USER_ID)).toBe(`USER#${USER_ID}`);
    expect(OrgKeys.membershipSk(ORG_ID)).toBe(`MEMBERSHIP#${ORG_ID}`);
  });

  it('parses the keys it builds and rejects anything else', () => {
    expect(parseOrgPk(OrgKeys.orgPk(ORG_ID))).toBe(ORG_ID);
    expect(parseUserPk(OrgKeys.userPk(USER_ID))).toBe(USER_ID);
    expect(parseMemberSk(OrgKeys.memberSk(USER_ID))).toBe(USER_ID);
    expect(parseMembershipSk(OrgKeys.membershipSk(ORG_ID))).toBe(ORG_ID);

    expect(parseOrgPk(`USER#${USER_ID}`)).toBeUndefined();
    expect(parseUserPk(`ORG#${ORG_ID}`)).toBeUndefined();
    expect(parseMemberSk('MEMBERSHIP#x')).toBeUndefined();
    expect(parseMembershipSk('MEMBER#x')).toBeUndefined();
    expect(parseOrgPk('ORG#')).toBeUndefined();
    // A key with a second `#` is not a plain id and must not be split into one.
    expect(parseOrgPk('ORG#a#b')).toBeUndefined();
    expect(parseMemberSk('MEMBER#a#b')).toBeUndefined();
    expect(parseMembershipSk('MEMBERSHIP#a#b')).toBeUndefined();
  });
});

describe('classifyOrg', () => {
  it('converts a legacy member row, carrying its joinedAt and the role it read', () => {
    const plan = classifyOrg(state({ legacyMembers: [legacyMember()] }), knownUsers);

    expect(plan).toEqual({
      kind: 'convert',
      orgId: ORG_ID,
      userId: USER_ID,
      joinedAt: JOINED_AT,
      fromRole: LEGACY_ROLE,
      origin: 'member-row',
      legacyRow: true,
      metaExists: false,
    });
  });

  it('accepts a legacy row that already reads owner', () => {
    const plan = classifyOrg(
      state({ legacyMembers: [legacyMember({ role: CONVERTED_ROLE })] }),
      knownUsers,
    );

    expect(plan.kind).toBe('convert');
  });

  it('repairs the early cohort from the org profile, using createdAt as joinedAt', () => {
    const plan = classifyOrg(state(), knownUsers);

    expect(plan).toEqual({
      kind: 'convert',
      orgId: ORG_ID,
      userId: USER_ID,
      joinedAt: CREATED_AT,
      origin: 'org-profile',
      legacyRow: false,
      metaExists: false,
    });
  });

  it('falls back to the org profile createdAt when the legacy row has no joinedAt', () => {
    // The inverse item's type requires joinedAt, so the attribute is always
    // written; the org's own creation date is the closest true value.
    const plan = classifyOrg(
      state({ legacyMembers: [{ userId: USER_ID, role: LEGACY_ROLE }] }),
      knownUsers,
    );

    expect(plan).toMatchObject({ kind: 'convert', joinedAt: CREATED_AT });
  });

  it('writes the epoch sentinel when no row records a date at all', () => {
    const fromMemberRow = classifyOrg(
      state({
        profile: { createdBy: USER_ID },
        legacyMembers: [{ userId: USER_ID, role: LEGACY_ROLE }],
      }),
      knownUsers,
    );
    const fromProfile = classifyOrg(state({ profile: { createdBy: USER_ID } }), knownUsers);

    expect(fromMemberRow).toMatchObject({ kind: 'convert', joinedAt: UNKNOWN_JOINED_AT });
    expect(fromProfile).toMatchObject({ kind: 'convert', joinedAt: UNKNOWN_JOINED_AT });
  });

  it('skips an org already in OrgTable and keeps its stale legacy row for deletion', () => {
    const plan = classifyOrg(
      state({ legacyMembers: [legacyMember()], orgTableMemberUserIds: [USER_ID] }),
      knownUsers,
    );

    expect(plan).toEqual({
      kind: 'already-converted',
      orgId: ORG_ID,
      userId: USER_ID,
      legacyRowPending: true,
    });
  });

  it('skips a post-deploy signup, which has no legacy row at all', () => {
    const plan = classifyOrg(state({ orgTableMemberUserIds: [USER_ID] }), knownUsers);

    expect(plan).toEqual({
      kind: 'already-converted',
      orgId: ORG_ID,
      userId: USER_ID,
      legacyRowPending: false,
    });
  });

  it('converts a reverted org, whose META the revert left behind', () => {
    // The revert restores the legacy row and leaves META alone. A legacy row
    // with no OrgTable member is an org waiting to be converted, whatever META
    // says — reading META first made every reverted org an anomaly.
    const plan = classifyOrg(state({ legacyMembers: [legacyMember()], hasMeta: true }), knownUsers);

    expect(plan).toMatchObject({ kind: 'convert', metaExists: true });
  });

  it('reports an org whose profile carries no createdBy', () => {
    const plan = classifyOrg(state({ profile: {} }), knownUsers);

    expect(plan).toMatchObject({ kind: 'anomaly', reason: 'profile-without-createdby' });
  });

  it('reports a member row naming a user with no profile', () => {
    const plan = classifyOrg(
      state({ legacyMembers: [legacyMember({ userId: 'ghost' })] }),
      knownUsers,
    );

    expect(plan).toMatchObject({ kind: 'anomaly', reason: 'unknown-user' });
  });

  it('reports a createdBy naming a user with no profile', () => {
    const plan = classifyOrg(state({ profile: { createdBy: 'ghost' } }), knownUsers);

    expect(plan).toMatchObject({ kind: 'anomaly', reason: 'unknown-user' });
  });

  it('reports an unexpected role instead of converting it to owner', () => {
    const plan = classifyOrg(
      state({ legacyMembers: [legacyMember({ role: 'member' })] }),
      knownUsers,
    );

    expect(plan).toMatchObject({ kind: 'anomaly', reason: 'unexpected-role' });
  });

  it('reports an org with more than one legacy member row', () => {
    const plan = classifyOrg(
      state({ legacyMembers: [legacyMember(), legacyMember({ userId: OTHER_USER_ID })] }),
      knownUsers,
    );

    expect(plan).toMatchObject({ kind: 'anomaly', reason: 'multiple-member-rows' });
  });

  it('reports member rows with no org profile', () => {
    const plan = classifyOrg(
      state({ profile: undefined, legacyMembers: [legacyMember()] }),
      knownUsers,
    );

    expect(plan).toMatchObject({ kind: 'anomaly', reason: 'missing-org-profile' });
  });

  it('still counts a converted org whose profile was deleted as converted', () => {
    // The runbook's disposition for missing-org-profile is to delete the
    // leftovers, so a converted org must never land there.
    const plan = classifyOrg(
      state({
        profile: undefined,
        legacyMembers: [legacyMember()],
        orgTableMemberUserIds: [USER_ID],
        hasMeta: true,
      }),
      knownUsers,
    );

    expect(plan).toMatchObject({ kind: 'already-converted', legacyRowPending: true });
  });

  it('refuses to repair an org whose member was removed after it was handled', () => {
    // META outlives a removed membership, so META with neither a member nor a
    // legacy row means the org was converted (or signed up) and somebody
    // deleted the membership.
    const plan = classifyOrg(state({ hasMeta: true }), knownUsers);

    expect(plan).toMatchObject({ kind: 'anomaly', reason: 'membership-removed' });
  });

  it('reports an OrgTable membership naming someone other than the legacy member', () => {
    const plan = classifyOrg(
      state({ legacyMembers: [legacyMember()], orgTableMemberUserIds: [OTHER_USER_ID] }),
      knownUsers,
    );

    expect(plan).toMatchObject({ kind: 'anomaly', reason: 'foreign-membership' });
  });
});

describe('buildConversionTransactItems', () => {
  it('writes the membership, its inverse item, and the owner count in one transaction', () => {
    expect(buildConversionTransactItems(convertPlan(), ORG_TABLE)).toEqual([
      {
        Put: {
          TableName: ORG_TABLE,
          Item: {
            pk: { S: `ORG#${ORG_ID}` },
            sk: { S: `MEMBER#${USER_ID}` },
            role: { S: CONVERTED_ROLE },
            joinedAt: { S: JOINED_AT },
            source: { S: CONVERSION_SOURCE },
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Put: {
          TableName: ORG_TABLE,
          Item: {
            pk: { S: `USER#${USER_ID}` },
            sk: { S: `MEMBERSHIP#${ORG_ID}` },
            role: { S: CONVERTED_ROLE },
            joinedAt: { S: JOINED_AT },
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Put: {
          TableName: ORG_TABLE,
          Item: {
            pk: { S: `ORG#${ORG_ID}` },
            sk: { S: 'META' },
            ownerCount: { N: '1' },
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
    ]);
  });

  it('converts the legacy admin value to owner', () => {
    const [membership] = buildConversionTransactItems(convertPlan(), ORG_TABLE);

    expect(putOf(membership).Item?.role).toEqual({ S: 'owner' });
  });

  it('makes every item conditional on its own absence, so a re-run cannot overwrite', () => {
    const items = buildConversionTransactItems(convertPlan(), ORG_TABLE);

    expect(items).toHaveLength(3);
    for (const item of items) {
      const put = putOf(item);
      expect(put.TableName).toBe(ORG_TABLE);
      expect(put.ConditionExpression).toBe('attribute_not_exists(pk)');
    }
  });

  it('leaves the META item out when the org already has one', () => {
    // An `attribute_not_exists` Put for a row that exists cancels the whole
    // transaction, so including it would fail the two membership writes beside
    // it — which is the state every reverted org is in.
    const items = buildConversionTransactItems(convertPlan({ metaExists: true }), ORG_TABLE);

    expect(items).toHaveLength(2);
    const sortKeys = items.map((item) => putOf(item).Item?.sk?.S);
    expect(sortKeys).toEqual([`MEMBER#${USER_ID}`, `MEMBERSHIP#${ORG_ID}`]);
  });

  it('always writes joinedAt, since the inverse item requires it', () => {
    const items = buildConversionTransactItems(
      convertPlan({ joinedAt: UNKNOWN_JOINED_AT, origin: 'org-profile', legacyRow: false }),
      ORG_TABLE,
    );

    expect(putOf(items[0]).Item?.joinedAt).toEqual({ S: UNKNOWN_JOINED_AT });
    expect(putOf(items[1]).Item?.joinedAt).toEqual({ S: UNKNOWN_JOINED_AT });
  });
});

describe('legacyMemberKey', () => {
  it('addresses the UserInfoTable row the conversion deletes', () => {
    expect(legacyMemberKey(ORG_ID, USER_ID)).toEqual({
      pk: { S: `ORG#${ORG_ID}` },
      sk: { S: `MEMBER#${USER_ID}` },
    });
  });
});

describe('buildRevertTransactItems', () => {
  const tables = { userInfoTable: USER_INFO_TABLE, orgTable: ORG_TABLE };

  it('restores the legacy admin row and removes both OrgTable rows', () => {
    const items = buildRevertTransactItems(
      { orgId: ORG_ID, userId: USER_ID, joinedAt: JOINED_AT },
      tables,
    );

    expect(items).toHaveLength(3);
    expect(putOf(items[0])).toEqual({
      TableName: USER_INFO_TABLE,
      Item: {
        pk: { S: `ORG#${ORG_ID}` },
        sk: { S: `MEMBER#${USER_ID}` },
        role: { S: LEGACY_ROLE },
        joinedAt: { S: JOINED_AT },
      },
    });
    expect(deleteOf(items[1])).toEqual({
      TableName: ORG_TABLE,
      Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: `MEMBER#${USER_ID}` } },
      // `source` and `role` are both DynamoDB reserved words, so both must be
      // aliased — a dropped alias fails the request at run time, not here.
      ConditionExpression: 'attribute_exists(pk) AND #source = :conversion AND #role = :owner',
      ExpressionAttributeNames: { '#source': 'source', '#role': 'role' },
      ExpressionAttributeValues: {
        ':conversion': { S: CONVERSION_SOURCE },
        ':owner': { S: CONVERTED_ROLE },
      },
    });
    expect(deleteOf(items[2])).toEqual({
      TableName: ORG_TABLE,
      Key: { pk: { S: `USER#${USER_ID}` }, sk: { S: `MEMBERSHIP#${ORG_ID}` } },
    });
  });

  it('does not touch the org META row', () => {
    const items = buildRevertTransactItems({ orgId: ORG_ID, userId: USER_ID }, tables);

    const touched = items.map((item) => item.Put?.Item?.sk?.S ?? item.Delete?.Key?.sk?.S);
    expect(touched).not.toContain('META');
  });
});

describe('willRevert', () => {
  it('acts on a row that still reads owner', () => {
    expect(willRevert({ orgId: ORG_ID, userId: USER_ID, role: CONVERTED_ROLE })).toBe(true);
  });

  it('declines a row whose role has been changed since the conversion', () => {
    // `source` alone would let the revert overwrite a later demotion with the
    // legacy admin value: a role change rewrites `role` and leaves `source`.
    expect(willRevert({ orgId: ORG_ID, userId: USER_ID, role: 'member' })).toBe(false);
    expect(willRevert({ orgId: ORG_ID, userId: USER_ID })).toBe(false);
  });
});

describe('classifyCancellation', () => {
  it('reads a failed condition as the data answering', () => {
    expect(classifyCancellation(['ConditionalCheckFailed', 'None', 'None'])).toBe(
      'condition-failed',
    );
  });

  it('retries throttling and transaction conflicts', () => {
    expect(classifyCancellation(['TransactionConflict', 'None'])).toBe('retry');
    expect(classifyCancellation(['None', 'ThrottlingError'])).toBe('retry');
    expect(classifyCancellation(['ProvisionedThroughputExceeded'])).toBe('retry');
  });

  it('aborts on anything else rather than filing it for manual review', () => {
    expect(classifyCancellation(['ValidationError'])).toBe('abort');
    expect(classifyCancellation(['ItemCollectionSizeLimitExceeded', 'None'])).toBe('abort');
    expect(classifyCancellation(['None', 'None'])).toBe('abort');
    expect(classifyCancellation([])).toBe('abort');
  });

  it('lets a failed condition win over a retryable reason in the same transaction', () => {
    expect(classifyCancellation(['ConditionalCheckFailed', 'TransactionConflict'])).toBe(
      'condition-failed',
    );
  });
});

describe('the conversion round trip', () => {
  // Two tables, enough of DynamoDB to hold the conversion and the revert to
  // their own conditions: a cancelled condition cancels the whole transaction,
  // which is what a META Put would do to a reverted org.
  type Table = Map<string, Record<string, AttributeValue>>;

  function rowKey(item: Record<string, AttributeValue>): string {
    return `${item.pk?.S ?? ''} ${item.sk?.S ?? ''}`;
  }

  function conditionHolds(
    existing: Record<string, AttributeValue> | undefined,
    expression: string | undefined,
    values: Record<string, AttributeValue> | undefined,
  ): boolean {
    if (!expression) return true;
    if (expression === 'attribute_not_exists(pk)') return existing === undefined;
    if (expression === 'attribute_exists(pk) AND #source = :conversion AND #role = :owner') {
      return (
        existing !== undefined &&
        existing.source?.S === values?.[':conversion']?.S &&
        existing.role?.S === values?.[':owner']?.S
      );
    }
    // Anything else means the builders grew a condition this fake does not
    // model, and a silently-true condition would make the test meaningless.
    throw new Error(`unmodelled condition: ${expression}`);
  }

  /** Applies a transaction, all-or-nothing. Returns false when a condition lost. */
  function transact(items: readonly TransactWriteItem[], tables: Record<string, Table>): boolean {
    for (const item of items) {
      const write = item.Put ?? item.Delete;
      const table = tables[write?.TableName ?? ''];
      if (!table) throw new Error(`unknown table: ${write?.TableName}`);

      const key = rowKey(item.Put?.Item ?? item.Delete?.Key ?? {});
      if (
        !conditionHolds(
          table.get(key),
          write?.ConditionExpression,
          write?.ExpressionAttributeValues,
        )
      ) {
        return false;
      }
    }

    for (const item of items) {
      if (item.Put) tables[item.Put.TableName!]!.set(rowKey(item.Put.Item!), item.Put.Item!);
      if (item.Delete) tables[item.Delete.TableName!]!.delete(rowKey(item.Delete.Key!));
    }
    return true;
  }

  /** The OrgState the conversion's two scans would build from these tables. */
  function readState(tables: Record<string, Table>): OrgState {
    const orgTable = tables[ORG_TABLE]!;
    const userInfo = tables[USER_INFO_TABLE]!;

    const legacyMembers = [...userInfo.values()]
      .filter((row) => row.pk?.S === OrgKeys.orgPk(ORG_ID) && row.sk?.S?.startsWith('MEMBER#'))
      .map((row) => ({
        userId: parseMemberSk(row.sk!.S!)!,
        ...(row.role?.S ? { role: row.role.S } : {}),
        ...(row.joinedAt?.S ? { joinedAt: row.joinedAt.S } : {}),
      }));

    const orgTableMemberUserIds = [...orgTable.values()]
      .filter((row) => row.pk?.S === OrgKeys.orgPk(ORG_ID) && row.sk?.S?.startsWith('MEMBER#'))
      .map((row) => parseMemberSk(row.sk!.S!)!);

    return {
      orgId: ORG_ID,
      profile: { createdBy: USER_ID, createdAt: CREATED_AT },
      legacyMembers,
      orgTableMemberUserIds,
      hasMeta: orgTable.has(`${OrgKeys.orgPk(ORG_ID)} META`),
    };
  }

  it('converts, reverts, and converts the same org again', () => {
    const tables: Record<string, Table> = { [ORG_TABLE]: new Map(), [USER_INFO_TABLE]: new Map() };
    tables[USER_INFO_TABLE]!.set(`${OrgKeys.orgPk(ORG_ID)} ${OrgKeys.memberSk(USER_ID)}`, {
      pk: { S: OrgKeys.orgPk(ORG_ID) },
      sk: { S: OrgKeys.memberSk(USER_ID) },
      role: { S: LEGACY_ROLE },
      joinedAt: { S: JOINED_AT },
    });

    // Convert.
    const first = classifyOrg(readState(tables), knownUsers);
    expect(first).toMatchObject({ kind: 'convert', metaExists: false });
    expect(transact(buildConversionTransactItems(first as ConvertPlan, ORG_TABLE), tables)).toBe(
      true,
    );
    tables[USER_INFO_TABLE]!.delete(`${OrgKeys.orgPk(ORG_ID)} ${OrgKeys.memberSk(USER_ID)}`);

    expect(classifyOrg(readState(tables), knownUsers)).toMatchObject({
      kind: 'already-converted',
      legacyRowPending: false,
    });

    // Revert. META stays behind, by design.
    const membership: ConvertedMembership = { orgId: ORG_ID, userId: USER_ID, joinedAt: JOINED_AT };
    expect(
      transact(
        buildRevertTransactItems(membership, {
          userInfoTable: USER_INFO_TABLE,
          orgTable: ORG_TABLE,
        }),
        tables,
      ),
    ).toBe(true);
    expect(tables[ORG_TABLE]!.has(`${OrgKeys.orgPk(ORG_ID)} META`)).toBe(true);

    // The reverted org re-classifies as Convert, not as an anomaly.
    const second = classifyOrg(readState(tables), knownUsers);
    expect(second).toMatchObject({ kind: 'convert', origin: 'member-row', metaExists: true });

    // And the second conversion lands: no META Put to cancel the transaction.
    const items = buildConversionTransactItems(second as ConvertPlan, ORG_TABLE);
    expect(items).toHaveLength(2);
    expect(transact(items, tables)).toBe(true);

    expect(tables[ORG_TABLE]!.get(`${OrgKeys.orgPk(ORG_ID)} ${OrgKeys.memberSk(USER_ID)}`)).toEqual(
      {
        pk: { S: OrgKeys.orgPk(ORG_ID) },
        sk: { S: OrgKeys.memberSk(USER_ID) },
        role: { S: CONVERTED_ROLE },
        joinedAt: { S: JOINED_AT },
        source: { S: CONVERSION_SOURCE },
      },
    );
    expect(
      tables[ORG_TABLE]!.has(`${OrgKeys.userPk(USER_ID)} ${OrgKeys.membershipSk(ORG_ID)}`),
    ).toBe(true);
  });

  it('cancels the whole conversion when a META Put meets an existing META', () => {
    // The bug the previous case exists to prevent, shown directly: keeping the
    // META item for an org that has one takes the membership writes down with
    // it.
    const tables: Record<string, Table> = { [ORG_TABLE]: new Map(), [USER_INFO_TABLE]: new Map() };
    tables[ORG_TABLE]!.set(`${OrgKeys.orgPk(ORG_ID)} META`, {
      pk: { S: OrgKeys.orgPk(ORG_ID) },
      sk: { S: 'META' },
      ownerCount: { N: '1' },
    });

    const withMetaPut = buildConversionTransactItems(convertPlan({ metaExists: false }), ORG_TABLE);
    expect(transact(withMetaPut, tables)).toBe(false);
    expect(tables[ORG_TABLE]!.size).toBe(1);

    const withoutMetaPut = buildConversionTransactItems(
      convertPlan({ metaExists: true }),
      ORG_TABLE,
    );
    expect(transact(withoutMetaPut, tables)).toBe(true);
    expect(tables[ORG_TABLE]!.size).toBe(3);
  });
});

describe('the plan report', () => {
  const scan: ScanCounts = {
    userInfoRows: 40,
    orgProfiles: 5,
    legacyMemberRows: 2,
    userProfiles: 5,
    unparsedRows: 0,
    orgTableMemberRows: 2,
    orgTableInverseRows: 2,
    orgTableMetaRows: 2,
  };

  const plans: OrgPlan[] = [
    convertPlan({ orgId: 'org-a', origin: 'member-row', legacyRow: true }),
    convertPlan({ orgId: 'org-b', origin: 'org-profile', legacyRow: false }),
    { kind: 'already-converted', orgId: 'org-c', userId: USER_ID, legacyRowPending: true },
    { kind: 'already-converted', orgId: 'org-d', userId: USER_ID, legacyRowPending: false },
    {
      kind: 'anomaly',
      orgId: 'org-e',
      reason: 'profile-without-createdby',
      detail: 'no MEMBER# row anywhere and PROFILE carries no createdBy to repair from',
    },
  ];

  it('counts each classification separately', () => {
    expect(summarizePlans(plans)).toEqual({
      orgs: 5,
      convertFromMemberRow: 1,
      repairFromProfile: 1,
      alreadyConverted: 2,
      legacyRowsPendingDelete: 1,
      metaToWrite: 2,
      anomalies: 1,
    });
  });

  it('reports the counts, the write volume, and every anomaly', () => {
    const report = formatPlanReport(scan, plans);

    expect(report).toContain('Orgs scanned: 5');
    expect(report).toMatch(/ {2}Convert \(legacy MEMBER# row -> OrgTable\): +1\n/);
    expect(report).toMatch(/ {2}Repair \(no membership row; from PROFILE\.createdBy\): +1\n/);
    expect(report).toMatch(/ {2}Already converted \(skipped\): +2\n/);
    expect(report).toMatch(/ {4}of which a legacy MEMBER# row remains to delete: +1\n/);
    expect(report).toMatch(/ {2}Anomalies \(manual disposition\): +1\n/);
    expect(report).toContain('[profile-without-createdby] ORG#org-e');
    // Two orgs to write, two membership items each plus two new META counters;
    // two legacy rows to delete (one conversion, one left behind by an
    // interrupted run).
    expect(report).toContain(
      'Writes 2 orgs (6 OrgTable items, of which 2 META counters) and deletes 2 legacy MEMBER# rows.',
    );
  });

  it('counts only the META rows it will actually write', () => {
    const reverted = plans.map((plan) =>
      plan.kind === 'convert' ? { ...plan, metaExists: true } : plan,
    );

    expect(formatPlanReport(scan, reverted)).toContain(
      'Writes 2 orgs (4 OrgTable items, of which 0 META counters)',
    );
  });

  it('says so plainly when there is nothing to disposition', () => {
    expect(formatPlanReport(scan, plans.slice(0, 2))).toContain('Anomalies: none.');
  });

  it('mentions unrecognized rows only when the scan found some', () => {
    expect(formatPlanReport(scan, plans)).not.toContain('Unrecognized key shapes');
    expect(formatPlanReport({ ...scan, unparsedRows: 3 }, plans)).toContain(
      'Unrecognized key shapes, ignored: 3',
    );
  });
});

describe('verifyConversion', () => {
  const converted = (orgId: string): OrgState => ({
    orgId,
    profile: { createdBy: USER_ID, createdAt: CREATED_AT },
    legacyMembers: [],
    orgTableMemberUserIds: [USER_ID],
    hasMeta: true,
  });

  /** Both OrgTable items every converted membership has, as the scan collects them. */
  function membershipScan(states: readonly OrgState[]): MembershipScan {
    const pairs = states.flatMap((one) =>
      one.orgTableMemberUserIds.map((userId) => ({
        orgId: one.orgId,
        userId,
        role: CONVERTED_ROLE,
      })),
    );
    return { members: [...pairs], inverse: [...pairs] };
  }

  function verify(
    states: OrgState[],
    overrides: Partial<ScanCounts> = {},
    accepted: string | undefined = undefined,
    membership: MembershipScan = membershipScan(states),
  ) {
    const plans = states.map((one) => classifyOrg(one, knownUsers));
    const scan: ScanResult = {
      membership,
      userInfoRows: 0,
      orgProfiles: states.length,
      legacyMemberRows: states.reduce((total, one) => total + one.legacyMembers.length, 0),
      userProfiles: 0,
      unparsedRows: 0,
      orgTableMemberRows: states.filter((one) => one.orgTableMemberUserIds.length > 0).length,
      orgTableInverseRows: states.filter((one) => one.orgTableMemberUserIds.length > 0).length,
      orgTableMetaRows: states.filter((one) => one.hasMeta).length,
      ...overrides,
    };
    return verifyConversion(states, plans, scan, parseAcceptedAnomalies(accepted));
  }

  const unexpectedRole = (orgId: string): OrgState => ({
    orgId,
    profile: { createdBy: USER_ID, createdAt: CREATED_AT },
    legacyMembers: [{ userId: USER_ID, role: 'member' }],
    orgTableMemberUserIds: [],
    hasMeta: false,
  });

  it('passes a fully converted stage', () => {
    const checks = verify([converted('org-a'), converted('org-b')]);

    expect(checks.every((check) => check.pass)).toBe(true);
    expect(formatVerifyReport(checks)).toContain('VERIFY: PASS');
  });

  it('fails an undispositioned anomaly, and enumerates the legacy row it kept', () => {
    const checks = verify([converted('org-a'), unexpectedRole('org-z')]);
    const report = formatVerifyReport(checks);

    expect(report).toContain('VERIFY: FAIL');
    expect(report).toContain('FAIL  Every anomaly has been dispositioned');
    expect(report).toContain('ORG#org-z [unexpected-role]');
    expect(report).toContain('ORG#org-z MEMBER#' + USER_ID + ' — unexpected-role');
  });

  it('passes once every anomaly is named, and echoes what was accepted', () => {
    const checks = verify(
      [converted('org-a'), unexpectedRole('org-z')],
      {},
      `${OrgKeys.orgPk('org-z')}`,
    );
    const report = formatVerifyReport(checks);

    expect(report).toContain('VERIFY: PASS');
    expect(report).toContain('accepted by --accept-anomalies (1):');
    expect(report).toContain('ORG#org-z [unexpected-role]');
  });

  it('accepts bare org ids as well as the ORG# form the report prints', () => {
    const checks = verify([unexpectedRole('org-z')], {}, 'org-z');

    expect(checks.every((check) => check.pass)).toBe(true);
  });

  it('still fails the anomalies nobody named', () => {
    const checks = verify([unexpectedRole('org-y'), unexpectedRole('org-z')], {}, 'org-z');
    const report = formatVerifyReport(checks);

    expect(report).toContain('VERIFY: FAIL');
    expect(report).toContain('1 accepted, 1 undispositioned');
    expect(report).toContain('ORG#org-y [unexpected-role]');
  });

  it('names an acceptance that no longer matches an anomaly', () => {
    const checks = verify([converted('org-a')], {}, 'org-a');

    expect(checks.every((check) => check.pass)).toBe(true);
    expect(formatVerifyReport(checks)).toContain('ORG#org-a — no longer an anomaly');
  });

  it('fails when an org is still convertible', () => {
    const pending: OrgState = {
      orgId: 'org-y',
      profile: { createdBy: USER_ID, createdAt: CREATED_AT },
      legacyMembers: [legacyMember()],
      orgTableMemberUserIds: [],
      hasMeta: false,
    };

    const checks = verify([pending]);
    const report = formatVerifyReport(checks);

    expect(report).toContain('VERIFY: FAIL');
    expect(report).toContain('FAIL  No org is still convertible');
    expect(report).toContain('ORG#org-y');
  });

  it('fails when a converted org still holds its legacy row', () => {
    const stale: OrgState = { ...converted('org-x'), legacyMembers: [legacyMember()] };

    const checks = verify([stale]);

    expect(formatVerifyReport(checks)).toContain(
      'FAIL  No converted org still holds its legacy row',
    );
  });

  it('names the membership whose inverse item is missing', () => {
    const states = [converted('org-a')];
    const checks = verify(states, { orgTableInverseRows: 0 }, undefined, {
      ...membershipScan(states),
      inverse: [],
    });
    const report = formatVerifyReport(checks);

    expect(report).toContain('FAIL  Membership rows and inverse items agree');
    expect(report).toContain(`ORG#org-a MEMBER#${USER_ID} — no MEMBERSHIP# inverse item`);
  });

  it('fails a missing inverse item and an orphan that cancel each other out in the counts', () => {
    const states = [converted('org-a'), converted('org-b')];
    const derived = membershipScan(states);
    const membership: MembershipScan = {
      members: derived.members,
      inverse: [
        ...derived.inverse.filter((pair) => pair.orgId !== 'org-a'),
        { orgId: 'org-gone', userId: USER_ID, role: CONVERTED_ROLE },
      ],
    };
    // The premise: the two breakages leave the two totals equal, which is all
    // the old cardinality check compared.
    expect(membership.inverse.length).toBe(membership.members.length);

    const report = formatVerifyReport(verify(states, {}, undefined, membership));

    expect(report).toContain('FAIL  Membership rows and inverse items agree');
    expect(report).toContain(`ORG#org-a MEMBER#${USER_ID} — no MEMBERSHIP# inverse item`);
    expect(report).toContain(`ORG#org-gone MEMBER#${USER_ID} — inverse item with no MEMBER# row`);
  });

  it('fails a membership whose two items disagree on role', () => {
    const states = [converted('org-a')];
    const derived = membershipScan(states);
    const report = formatVerifyReport(
      verify(states, {}, undefined, {
        members: derived.members,
        inverse: derived.inverse.map((pair) => ({ ...pair, role: LEGACY_ROLE })),
      }),
    );

    expect(report).toContain('FAIL  Membership rows and inverse items agree');
    expect(report).toContain(
      `ORG#org-a MEMBER#${USER_ID} — MEMBER# says ${CONVERTED_ROLE}, inverse item says ${LEGACY_ROLE}`,
    );
  });

  it('fails when a membership has no META counter', () => {
    const noMeta: OrgState = { ...converted('org-w'), hasMeta: false };

    const checks = verify([noMeta]);

    expect(formatVerifyReport(checks)).toContain(
      'FAIL  Every org with a membership has its META counter',
    );
  });

  it('accepts a META with no membership only as a removed membership', () => {
    const removed: OrgState = {
      orgId: 'org-v',
      profile: { createdBy: USER_ID, createdAt: CREATED_AT },
      legacyMembers: [],
      orgTableMemberUserIds: [],
      hasMeta: true,
    };

    // A removed membership is still an anomaly, so it needs the same explicit
    // disposition as any other; what this asserts is that the META check itself
    // is satisfied by the classification.
    const checks = verify([removed], {}, 'org-v');

    expect(formatVerifyReport(checks)).toContain('VERIFY: PASS');
    expect(
      checks.find(
        (check) => check.name === 'Every META without a membership is a removed membership',
      )?.pass,
    ).toBe(true);
  });
});
