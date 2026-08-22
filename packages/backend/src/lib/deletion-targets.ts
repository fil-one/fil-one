import { GetItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import type { DeletionMember } from './deletion-record.js';
import { listMemberships, OrgKeys, type OrgMembershipSource } from './org-membership.js';
import { getProvisionedRegions } from './region-helpers.js';

const LOG = '[deletion-targets]';

/**
 * Everything teardown needs, resolved at the start of each pass. The scrub retains
 * every row read here, so a re-drive resolves the same answer.
 *
 * Reads are strongly consistent throughout: a member or tenant missed here is
 * never torn down, and nothing later can notice the omission.
 */
export async function resolveDeletionTargets(orgId: string): Promise<{
  members: DeletionMember[];
  tenantIds: Record<string, string>;
}> {
  const [members, provisioned] = await Promise.all([
    resolveMembers(orgId),
    getProvisionedRegions(orgId, { consistent: true }),
  ]);

  return {
    members,
    tenantIds: Object.fromEntries(provisioned.map((r) => [r.orchestrator.id, r.tenantId])),
  };
}

/** A member as the two enumerations find them, before their account is resolved. */
interface MemberRow {
  userId: string;
  /** From the OrgTable row. A legacy row records none, and none reads as personal. */
  source?: string;
}

async function resolveMembers(orgId: string): Promise<DeletionMember[]> {
  const rows = await listMemberRows(orgId);
  const members = await Promise.all(rows.map((row) => resolveMember(orgId, row)));
  return members.filter((m): m is DeletionMember => m !== undefined);
}

/**
 * The org's members, from both tables.
 *
 * Membership lives in OrgTable. It lived in UserInfoTable until the conversion
 * moved it, and the conversion runs org by org, so during that window an
 * unconverted org has rows only in UserInfoTable and a converted one only in
 * OrgTable. Reading both and taking the union means neither state resolves an
 * empty member list, which teardown would read as an org with nothing to tear
 * down and mark itself done.
 *
 * The OrgTable row wins on a duplicate: it carries how the member joined, which
 * the legacy row never recorded.
 */
async function listMemberRows(orgId: string): Promise<MemberRow[]> {
  const [current, legacy] = await Promise.all([
    listOrgTableMembers(orgId),
    listLegacyMembers(orgId),
  ]);

  const rows = new Map<string, MemberRow>();
  for (const userId of legacy) rows.set(userId, { userId });
  for (const row of current) rows.set(row.userId, row);
  return [...rows.values()];
}

/** OrgTable — `ORG#{orgId}` / `MEMBER#{userId}`, the authoritative membership. */
async function listOrgTableMembers(orgId: string): Promise<MemberRow[]> {
  const items = await queryAll({
    tableName: Resource.OrgTable.name,
    pk: OrgKeys.orgPk(orgId),
    prefix: OrgKeys.memberSkPrefix(),
    projection: 'sk, #source',
    names: { '#source': 'source' },
  });

  const rows: MemberRow[] = [];
  for (const item of items) {
    const userId = parseMemberSk(item.sk?.S);
    if (!userId) continue;
    const source = item.source?.S;
    rows.push({ userId, ...(source ? { source } : {}) });
  }
  return rows;
}

/** UserInfoTable — the pre-conversion membership row, for an org not yet converted. */
async function listLegacyMembers(orgId: string): Promise<string[]> {
  const items = await queryAll({
    tableName: Resource.UserInfoTable.name,
    pk: `ORG#${orgId}`,
    prefix: OrgKeys.memberSkPrefix(),
    projection: 'sk',
  });

  const userIds: string[] = [];
  for (const item of items) {
    const userId = parseMemberSk(item.sk?.S);
    if (userId) userIds.push(userId);
  }
  return userIds;
}

/** Org and user ids are UUIDs and contain no `#`, so the split is unambiguous. */
function parseMemberSk(sk: string | undefined): string | undefined {
  const prefix = OrgKeys.memberSkPrefix();
  if (!sk?.startsWith(prefix)) return undefined;
  const userId = sk.slice(prefix.length);
  return userId && !userId.includes('#') ? userId : undefined;
}

async function queryAll(params: {
  tableName: string;
  pk: string;
  prefix: string;
  projection: string;
  names?: Record<string, string>;
}): Promise<Record<string, AttributeValue>[]> {
  const dynamo = getDynamoClient();
  const items: Record<string, AttributeValue>[] = [];
  let cursor: Record<string, AttributeValue> | undefined;

  do {
    const page = await dynamo.send(
      new QueryCommand({
        TableName: params.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: marshall({ ':pk': params.pk, ':prefix': params.prefix }),
        ProjectionExpression: params.projection,
        ...(params.names ? { ExpressionAttributeNames: params.names } : {}),
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    items.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  return items;
}

async function resolveMember(orgId: string, row: MemberRow): Promise<DeletionMember | undefined> {
  const dynamo = getDynamoClient();
  const [profile, billing, memberships] = await Promise.all([
    dynamo.send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: `USER#${row.userId}`, sk: 'PROFILE' }),
        // `sub` is a DynamoDB reserved word, hence #sub.
        ProjectionExpression: '#sub',
        ExpressionAttributeNames: { '#sub': 'sub' },
        ConsistentRead: true,
      }),
    ),
    dynamo.send(
      new GetItemCommand({
        TableName: Resource.BillingTable.name,
        Key: marshall({ pk: `CUSTOMER#${row.userId}`, sk: 'SUBSCRIPTION' }),
        ProjectionExpression: 'stripeCustomerId',
        ConsistentRead: true,
      }),
    ),
    listMemberships(row.userId),
  ]);

  const sub = profile.Item?.sub?.S;
  if (!sub) {
    // Nothing to delete in Auth0 and no identity row to stamp. Loud, because it
    // means the account can outlive its org, but it must not wedge the pass.
    console.error(`${LOG} no sub on USER#${row.userId}/PROFILE; leaving that member behind`);
    return undefined;
  }

  const otherOrgIds = memberships.map((m) => m.orgId).filter((id) => id !== orgId);
  const stripeCustomerId = billing.Item?.stripeCustomerId?.S;
  return {
    userId: row.userId,
    sub,
    ...(stripeCustomerId ? { stripeCustomerId } : {}),
    deleteIdentity: censusMember(orgId, row, otherOrgIds),
  };
}

const INVITED: OrgMembershipSource = 'invitation';

/**
 * Whether this org's deletion ends the member's account.
 *
 * Two conditions, both required. The org must be the member's only one, because
 * an account with another membership still has somewhere to log in to. And the
 * membership must be the member's own rather than an invitation, because an
 * invited member's account was never this org's to delete — the same test
 * `isSoloPersonalOrg` applies to a trial claim.
 *
 * A member the conversion has not reached yet has no inverse items and no
 * recorded source, so both conditions hold and the account is torn down as it
 * was before this change.
 *
 * Logged per member, because it is the decision that separates a deleted account
 * from a kept one and nothing else records it.
 */
function censusMember(orgId: string, row: MemberRow, otherOrgIds: string[]): boolean {
  const soleMembership = otherOrgIds.length === 0;
  const personalOrg = row.source !== INVITED;
  const deleteIdentity = soleMembership && personalOrg;

  console.log(`${LOG} membership census`, {
    orgId,
    userId: row.userId,
    source: row.source ?? 'none recorded',
    otherOrgIds,
    deleteIdentity,
  });

  return deleteIdentity;
}
