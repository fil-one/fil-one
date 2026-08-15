// Pure helpers for the org-membership conversion (IAM M1, FIL-1013): what to do
// with each org, and the exact DynamoDB items that carry it out. Everything here
// is a function of its arguments — no AWS client, no `Resource`, no clock — so
// the conversion's decisions are testable without a table.
//
// The runners are ./convert-orgs-to-orgtable.ts and ./revert-org-conversion.ts;
// the procedure is docs/OrgConversionRunbook.md.
//
// KEY BUILDERS ARE MIRRORED, NOT IMPORTED. The canonical definitions live in
// packages/backend/src/lib/org-membership.ts (`OrgKeys`) and the role values in
// packages/shared/src/api/org.ts (`OrgRole`). Scripts in bin/ run as
// `node ./bin/<script>.ts` under Node's type stripping, which resolves neither
// the backend's `./x.js` specifiers (no .js -> .ts fallback) nor the `OrgRole`
// enum (not erasable syntax), so a bin script cannot import from either package
// — the same constraint bin/backfill-access-key-granular-permissions.ts records
// for its permission map. Keep this file in sync with those two by hand; the
// key shapes are pinned by tests in ./org-conversion.test.ts.

import type { AttributeValue, TransactWriteItem } from '@aws-sdk/client-dynamodb';

/** OrgTable keys — mirror of `OrgKeys` in packages/backend/src/lib/org-membership.ts. */
export const OrgKeys = {
  orgPk: (orgId: string): string => `ORG#${orgId}`,
  orgPkPrefix: (): string => 'ORG#',
  memberSk: (userId: string): string => `MEMBER#${userId}`,
  memberSkPrefix: (): string => 'MEMBER#',
  orgMetaSk: (): string => 'META',
  userPk: (userId: string): string => `USER#${userId}`,
  userPkPrefix: (): string => 'USER#',
  membershipSk: (orgId: string): string => `MEMBERSHIP#${orgId}`,
} as const;

/**
 * The UserInfoTable rows this conversion reads. Org and user profiles share the
 * `PROFILE` sort key; the legacy membership row has the same key shape as its
 * OrgTable successor, which is what makes the move an address change.
 */
export const UserInfoKeys = {
  profileSk: (): string => 'PROFILE',
} as const;

/** Mirror of `OrgRole.Owner` — what every converted membership becomes. */
export const CONVERTED_ROLE = 'owner';
/** Mirror of `OrgRole.Admin` — the value every pre-M1 membership row carries. */
export const LEGACY_ROLE = 'admin';
/** Mirror of `OrgMembershipSource` — how a converted member came to be a member. */
export const CONVERSION_SOURCE = 'conversion';

/** `ORG#{orgId}` -> orgId. Undefined for any other shape; org ids contain no `#`. */
export function parseOrgPk(pk: string): string | undefined {
  return parsePrefixed(pk, OrgKeys.orgPkPrefix());
}

/** `USER#{userId}` -> userId. */
export function parseUserPk(pk: string): string | undefined {
  return parsePrefixed(pk, OrgKeys.userPkPrefix());
}

/** `MEMBER#{userId}` -> userId. */
export function parseMemberSk(sk: string): string | undefined {
  return parsePrefixed(sk, OrgKeys.memberSkPrefix());
}

function parsePrefixed(value: string, prefix: string): string | undefined {
  const rest = value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
  return rest && !rest.includes('#') ? rest : undefined;
}

/** The `ORG#{orgId}/PROFILE` row, reduced to what the conversion reads from it. */
export interface OrgProfile {
  /** The account's creator — the repair source for the early no-membership cohort. */
  createdBy?: string;
  createdAt?: string;
}

/** A legacy `ORG#{orgId}/MEMBER#{userId}` row in UserInfoTable. */
export interface LegacyMemberRow {
  userId: string;
  role?: string;
  joinedAt?: string;
}

/** Everything known about one org, assembled from the two table scans. */
export interface OrgState {
  orgId: string;
  profile?: OrgProfile;
  legacyMembers: LegacyMemberRow[];
  /** Members this org already has in OrgTable: a converted org, or a post-deploy signup. */
  orgTableMemberUserIds: string[];
  /**
   * Whether `ORG#{orgId}/META` exists. Only signup and this conversion write it,
   * and member removal decrements `ownerCount` rather than deleting the row, so
   * a META with no membership means the org was handled and its member removed
   * — never that the org is waiting to be converted.
   */
  hasMeta: boolean;
}

/**
 * Why an org is left for a human. Nothing on this list is repaired
 * automatically: each one means the data says something the conversion was not
 * designed to decide.
 */
export type AnomalyReason =
  | 'profile-without-createdby'
  | 'unknown-user'
  | 'unexpected-role'
  | 'multiple-member-rows'
  | 'missing-org-profile'
  | 'foreign-membership'
  | 'membership-removed';

/** Where the membership being written came from. */
export type ConversionOrigin = 'member-row' | 'org-profile';

export interface ConvertPlan {
  kind: 'convert';
  orgId: string;
  userId: string;
  /** Carried from the legacy row, or the org profile's `createdAt` for a repair. Omitted when neither records one. */
  joinedAt?: string;
  /** The role as stored, so the log names what was read rather than what was expected. */
  fromRole?: string;
  origin: ConversionOrigin;
  /** Whether a legacy UserInfoTable `MEMBER#` row remains to be deleted afterwards. */
  legacyRow: boolean;
}

export interface AlreadyConvertedPlan {
  kind: 'already-converted';
  orgId: string;
  userId: string;
  /** A legacy row left behind by an interrupted run: the OrgTable write landed, the delete did not. */
  legacyRowPending: boolean;
}

export interface AnomalyPlan {
  kind: 'anomaly';
  orgId: string;
  reason: AnomalyReason;
  detail: string;
}

export type OrgPlan = ConvertPlan | AlreadyConvertedPlan | AnomalyPlan;

/**
 * What to do with one org.
 *
 * The classification is a function of live data alone, which is what makes the
 * run resumable: a re-run re-reads both tables and re-derives the same decision
 * for every org it already finished ('already-converted'), so an interrupted
 * run needs no checkpoint and no bookkeeping of its own.
 */
export function classifyOrg(state: OrgState, knownUserIds: ReadonlySet<string>): OrgPlan {
  if (state.legacyMembers.length > 1) {
    const userIds = state.legacyMembers.map((member) => member.userId).join(', ');
    return anomaly(
      state.orgId,
      'multiple-member-rows',
      `${state.legacyMembers.length} legacy MEMBER# rows (${userIds}) — an org of one was expected`,
    );
  }

  if (state.hasMeta && state.orgTableMemberUserIds.length === 0) {
    // Nothing in this script writes META without a membership, so the org was
    // converted or signed up and its member removed afterwards. Repairing it
    // from PROFILE.createdBy would resurrect a membership somebody deleted.
    return anomaly(
      state.orgId,
      'membership-removed',
      'META exists with no membership row — the org was already handled and its member removed since',
    );
  }

  const legacy = state.legacyMembers[0];
  return legacy
    ? classifyWithMemberRow(state, legacy, knownUserIds)
    : classifyWithoutMemberRow(state, knownUserIds);
}

function classifyWithMemberRow(
  state: OrgState,
  legacy: LegacyMemberRow,
  knownUserIds: ReadonlySet<string>,
): OrgPlan {
  const { orgId } = state;
  const { userId, role } = legacy;

  // Ahead of every other check: a converted org whose profile was deleted is
  // still converted, and calling it an anomaly would send an operator to
  // dispose of rows that are doing their job.
  if (state.orgTableMemberUserIds.includes(userId)) {
    return { kind: 'already-converted', orgId, userId, legacyRowPending: true };
  }
  if (!state.profile) {
    return anomaly(orgId, 'missing-org-profile', `MEMBER#${userId} with no ORG#/PROFILE row`);
  }
  if (state.orgTableMemberUserIds.length > 0) {
    return anomaly(
      orgId,
      'foreign-membership',
      `OrgTable holds MEMBER#${state.orgTableMemberUserIds.join(', MEMBER#')} but the legacy row names ${userId}`,
    );
  }
  if (!knownUserIds.has(userId)) {
    return anomaly(orgId, 'unknown-user', `MEMBER#${userId} has no USER#${userId}/PROFILE row`);
  }
  if (role !== LEGACY_ROLE && role !== CONVERTED_ROLE) {
    return anomaly(
      orgId,
      'unexpected-role',
      `MEMBER#${userId} carries role="${role ?? ''}", expected "${LEGACY_ROLE}"`,
    );
  }

  return {
    kind: 'convert',
    orgId,
    userId,
    ...(legacy.joinedAt ? { joinedAt: legacy.joinedAt } : {}),
    ...(role ? { fromRole: role } : {}),
    origin: 'member-row',
    legacyRow: true,
  };
}

function classifyWithoutMemberRow(state: OrgState, knownUserIds: ReadonlySet<string>): OrgPlan {
  const { orgId } = state;

  const converted = state.orgTableMemberUserIds[0];
  if (converted) {
    return { kind: 'already-converted', orgId, userId: converted, legacyRowPending: false };
  }
  if (!state.profile) {
    return anomaly(orgId, 'missing-org-profile', 'no MEMBER# row and no ORG#/PROFILE row');
  }

  const createdBy = state.profile.createdBy;
  if (!createdBy) {
    return anomaly(
      orgId,
      'profile-without-createdby',
      'no MEMBER# row anywhere and PROFILE carries no createdBy to repair from',
    );
  }
  if (!knownUserIds.has(createdBy)) {
    return anomaly(
      orgId,
      'unknown-user',
      `PROFILE.createdBy=${createdBy} has no USER#${createdBy}/PROFILE row`,
    );
  }

  return {
    kind: 'convert',
    orgId,
    userId: createdBy,
    ...(state.profile.createdAt ? { joinedAt: state.profile.createdAt } : {}),
    origin: 'org-profile',
    legacyRow: false,
  };
}

function anomaly(orgId: string, reason: AnomalyReason, detail: string): AnomalyPlan {
  return { kind: 'anomaly', orgId, reason, detail };
}

/**
 * The three OrgTable items one org's conversion writes, as a single transaction.
 *
 * Every item is conditional on its own absence, which is what makes the write
 * safe to repeat and safe to race: a re-run and a signup that happened after the
 * write path deployed both lose the condition rather than overwriting a live
 * membership. The transaction is all-or-nothing, so an org is never left with a
 * canonical row and no inverse item.
 */
export function buildConversionTransactItems(
  plan: ConvertPlan,
  orgTableName: string,
): TransactWriteItem[] {
  const { orgId, userId, joinedAt } = plan;
  // Omitted rather than invented when the source row records no timestamp: the
  // attribute is optional on the membership record, and a fabricated join date
  // would be indistinguishable from a real one.
  const joined: Record<string, AttributeValue> = joinedAt ? { joinedAt: { S: joinedAt } } : {};

  return [
    {
      Put: {
        TableName: orgTableName,
        Item: {
          pk: { S: OrgKeys.orgPk(orgId) },
          sk: { S: OrgKeys.memberSk(userId) },
          role: { S: CONVERTED_ROLE },
          ...joined,
          source: { S: CONVERSION_SOURCE },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Put: {
        TableName: orgTableName,
        Item: {
          pk: { S: OrgKeys.userPk(userId) },
          sk: { S: OrgKeys.membershipSk(orgId) },
          role: { S: CONVERTED_ROLE },
          ...joined,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Put: {
        TableName: orgTableName,
        Item: {
          pk: { S: OrgKeys.orgPk(orgId) },
          sk: { S: OrgKeys.orgMetaSk() },
          ownerCount: { N: '1' },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
  ];
}

/** The legacy UserInfoTable membership row's key — deleted only after its OrgTable transaction succeeds. */
export function legacyMemberKey(orgId: string, userId: string): Record<string, AttributeValue> {
  return { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.memberSk(userId) } };
}

/** A converted membership as the revert reads it back off OrgTable. */
export interface ConvertedMembership {
  orgId: string;
  userId: string;
  joinedAt?: string;
}

/**
 * Undo one converted membership in a single cross-table transaction: the legacy
 * row comes back, the two OrgTable rows go away, and neither half can land
 * without the other.
 *
 * The canonical delete is conditional on the row still being a conversion's and
 * still carrying Owner. A role change writes the role and leaves `source`
 * alone, so `source` by itself would let the revert overwrite a demotion with
 * the legacy `admin`; both conditions together confine it to rows no one has
 * touched since the conversion. The inverse item cannot be guarded — it stores
 * no `source` — so it rides the canonical row's condition inside the same
 * transaction and is deleted only when that one is.
 *
 * The legacy Put carries no condition: its content is the row the conversion
 * deleted, so rewriting one an interrupted run left behind restores the same
 * values rather than wedging the revert.
 */
export function buildRevertTransactItems(
  membership: ConvertedMembership,
  tables: { userInfoTable: string; orgTable: string },
): TransactWriteItem[] {
  const { orgId, userId, joinedAt } = membership;
  const joined: Record<string, AttributeValue> = joinedAt ? { joinedAt: { S: joinedAt } } : {};

  return [
    {
      Put: {
        TableName: tables.userInfoTable,
        Item: {
          pk: { S: OrgKeys.orgPk(orgId) },
          sk: { S: OrgKeys.memberSk(userId) },
          role: { S: LEGACY_ROLE },
          ...joined,
        },
      },
    },
    {
      Delete: {
        TableName: tables.orgTable,
        Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.memberSk(userId) } },
        ConditionExpression: 'attribute_exists(pk) AND #source = :conversion AND #role = :owner',
        ExpressionAttributeNames: { '#source': 'source', '#role': 'role' },
        ExpressionAttributeValues: {
          ':conversion': { S: CONVERSION_SOURCE },
          ':owner': { S: CONVERTED_ROLE },
        },
      },
    },
    {
      Delete: {
        TableName: tables.orgTable,
        Key: { pk: { S: OrgKeys.userPk(userId) }, sk: { S: OrgKeys.membershipSk(orgId) } },
      },
    },
  ];
}

/** What the two scans found, before any classification. */
export interface ScanCounts {
  /** Rows the UserInfoTable scan's filter matched — not the table's size. */
  userInfoRows: number;
  orgProfiles: number;
  legacyMemberRows: number;
  userProfiles: number;
  /** Matched rows whose key parsed as none of the three shapes above. */
  unparsedRows: number;
  orgTableMemberRows: number;
  orgTableMetaRows: number;
}

/** What the classification decided, in the shape the report prints. */
export interface PlanCounts {
  orgs: number;
  convertFromMemberRow: number;
  repairFromProfile: number;
  alreadyConverted: number;
  legacyRowsPendingDelete: number;
  anomalies: number;
}

export function summarizePlans(plans: readonly OrgPlan[]): PlanCounts {
  const counts: PlanCounts = {
    orgs: plans.length,
    convertFromMemberRow: 0,
    repairFromProfile: 0,
    alreadyConverted: 0,
    legacyRowsPendingDelete: 0,
    anomalies: 0,
  };

  for (const plan of plans) {
    if (plan.kind === 'convert') {
      if (plan.origin === 'member-row') counts.convertFromMemberRow++;
      else counts.repairFromProfile++;
    } else if (plan.kind === 'already-converted') {
      counts.alreadyConverted++;
      if (plan.legacyRowPending) counts.legacyRowsPendingDelete++;
    } else {
      counts.anomalies++;
    }
  }

  return counts;
}

/**
 * The report both modes print before anything is written. Execute prints the
 * same plan a dry run does, so what an operator approves is what runs.
 */
export function formatPlanReport(scan: ScanCounts, plans: readonly OrgPlan[]): string {
  const counts = summarizePlans(plans);
  const writes = counts.convertFromMemberRow + counts.repairFromProfile;
  const lines = [
    `Matched in UserInfoTable: ${scan.userInfoRows} rows — ${scan.orgProfiles} org profiles, ${scan.legacyMemberRows} legacy MEMBER# rows, ${scan.userProfiles} user profiles`,
    ...(scan.unparsedRows > 0 ? [`  Unrecognized key shapes, ignored: ${scan.unparsedRows}`] : []),
    `Matched in OrgTable: ${scan.orgTableMemberRows} MEMBER# rows, ${scan.orgTableMetaRows} META rows`,
    '',
    `Orgs scanned: ${counts.orgs}`,
    ...alignedCounts([
      ['  Convert (legacy MEMBER# row -> OrgTable)', counts.convertFromMemberRow],
      ['  Repair (no membership row; from PROFILE.createdBy)', counts.repairFromProfile],
      ['  Already converted (skipped)', counts.alreadyConverted],
      ['    of which a legacy MEMBER# row remains to delete', counts.legacyRowsPendingDelete],
      ['  Anomalies (manual disposition)', counts.anomalies],
    ]),
    '',
    ...formatAnomalies(plans),
    `Writes ${writes} orgs (${writes * 3} OrgTable items) and deletes ${counts.convertFromMemberRow + counts.legacyRowsPendingDelete} legacy MEMBER# rows.`,
  ];

  return lines.join('\n');
}

/** One column of labels, one of numbers — the counts are meant to be compared down the page. */
function alignedCounts(rows: readonly (readonly [string, number])[]): string[] {
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return rows.map(([label, value]) => `${`${label}:`.padEnd(width)}${value}`);
}

function formatAnomalies(plans: readonly OrgPlan[]): string[] {
  const anomalies = plans.filter((plan): plan is AnomalyPlan => plan.kind === 'anomaly');
  if (anomalies.length === 0) return ['Anomalies: none.', ''];

  return [
    'Anomalies — dispose of these before executing:',
    ...anomalies.map((plan) => `  [${plan.reason}] ${OrgKeys.orgPk(plan.orgId)}  ${plan.detail}`),
    '',
  ];
}
