import { describe, expect, it } from 'vitest';

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
  parseOrgPk,
  parseUserPk,
  summarizePlans,
} from './org-conversion.ts';
import type { ConvertPlan, OrgPlan, OrgState, ScanCounts } from './org-conversion.ts';

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

describe('key builders', () => {
  // Mirrored from packages/backend/src/lib/org-membership.ts — these strings are
  // the contract between the conversion and the code that reads the rows.
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

    expect(parseOrgPk(`USER#${USER_ID}`)).toBeUndefined();
    expect(parseUserPk(`ORG#${ORG_ID}`)).toBeUndefined();
    expect(parseMemberSk('MEMBERSHIP#x')).toBeUndefined();
    expect(parseOrgPk('ORG#')).toBeUndefined();
    // A key with a second `#` is not a plain id and must not be split into one.
    expect(parseOrgPk('ORG#a#b')).toBeUndefined();
    expect(parseMemberSk('MEMBER#a#b')).toBeUndefined();
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
    });
  });

  it('omits joinedAt rather than inventing one when no row records it', () => {
    const fromMemberRow = classifyOrg(
      state({ legacyMembers: [{ userId: USER_ID, role: LEGACY_ROLE }] }),
      knownUsers,
    );
    const fromProfile = classifyOrg(state({ profile: { createdBy: USER_ID } }), knownUsers);

    expect(fromMemberRow).not.toHaveProperty('joinedAt');
    expect(fromProfile).not.toHaveProperty('joinedAt');
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
    // META outlives a removed membership, so META without a member means the
    // org was converted (or signed up) and somebody deleted the membership.
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
  const plan: ConvertPlan = {
    kind: 'convert',
    orgId: ORG_ID,
    userId: USER_ID,
    joinedAt: JOINED_AT,
    origin: 'member-row',
    legacyRow: true,
  };

  it('writes the membership, its inverse item, and the owner count in one transaction', () => {
    expect(buildConversionTransactItems(plan, ORG_TABLE)).toEqual([
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
    const [membership] = buildConversionTransactItems(plan, ORG_TABLE);

    expect(membership.Put?.Item?.role).toEqual({ S: 'owner' });
    expect(CONVERTED_ROLE).not.toBe(LEGACY_ROLE);
  });

  it('makes every item conditional on its own absence, so a re-run cannot overwrite', () => {
    const items = buildConversionTransactItems(plan, ORG_TABLE);

    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.Put?.ConditionExpression).toBe('attribute_not_exists(pk)');
    }
  });

  it('leaves joinedAt off both rows when the plan has none', () => {
    const items = buildConversionTransactItems(
      { ...plan, joinedAt: undefined, origin: 'org-profile', legacyRow: false },
      ORG_TABLE,
    );

    expect(items[0].Put?.Item).not.toHaveProperty('joinedAt');
    expect(items[1].Put?.Item).not.toHaveProperty('joinedAt');
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

    expect(items[0].Put).toEqual({
      TableName: USER_INFO_TABLE,
      Item: {
        pk: { S: `ORG#${ORG_ID}` },
        sk: { S: `MEMBER#${USER_ID}` },
        role: { S: LEGACY_ROLE },
        joinedAt: { S: JOINED_AT },
      },
    });
    expect(items[1].Delete?.Key).toEqual({
      pk: { S: `ORG#${ORG_ID}` },
      sk: { S: `MEMBER#${USER_ID}` },
    });
    expect(items[2].Delete?.Key).toEqual({
      pk: { S: `USER#${USER_ID}` },
      sk: { S: `MEMBERSHIP#${ORG_ID}` },
    });
  });

  it('deletes only a conversion row that still carries owner', () => {
    // `source` alone would let the revert overwrite a later demotion with the
    // legacy admin value: a role change rewrites `role` and leaves `source`.
    const [, membershipDelete] = buildRevertTransactItems(
      { orgId: ORG_ID, userId: USER_ID },
      tables,
    );

    expect(membershipDelete.Delete?.ConditionExpression).toBe(
      'attribute_exists(pk) AND #source = :conversion AND #role = :owner',
    );
    expect(membershipDelete.Delete?.ExpressionAttributeValues).toEqual({
      ':conversion': { S: CONVERSION_SOURCE },
      ':owner': { S: CONVERTED_ROLE },
    });
  });

  it('does not touch the org META row', () => {
    const items = buildRevertTransactItems({ orgId: ORG_ID, userId: USER_ID }, tables);

    const touched = items.map((item) => item.Put?.Item?.sk?.S ?? item.Delete?.Key?.sk?.S);
    expect(touched).not.toContain('META');
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
    orgTableMetaRows: 2,
  };

  const plans: OrgPlan[] = [
    { kind: 'convert', orgId: 'org-a', userId: USER_ID, origin: 'member-row', legacyRow: true },
    { kind: 'convert', orgId: 'org-b', userId: USER_ID, origin: 'org-profile', legacyRow: false },
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
    // Two orgs to write, three items each; two legacy rows to delete (one
    // conversion, one left behind by an interrupted run).
    expect(report).toContain('Writes 2 orgs (6 OrgTable items) and deletes 2 legacy MEMBER# rows.');
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
