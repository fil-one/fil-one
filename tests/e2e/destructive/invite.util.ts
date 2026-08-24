import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';

// Seeds and tears down the organization state the members specs drive.
//
// The console can only reach these states through somebody else's session — an
// invitation is redeemed by the person it names, and a second member exists only
// because one was accepted — so the rows are written here instead, the way
// billing-reset.util.ts re-seeds BillingTable. Every shape below mirrors the
// writer it stands in for; the source of truth for each is named above it, and a
// divergence is a bug in this file rather than a variation:
//
// - packages/backend/src/lib/invitations.ts  — INVITE# and INVITETOKEN# rows
// - packages/backend/src/lib/membership-changes.ts — MEMBER#/MEMBERSHIP# rows
//                                                    and the ownerCount counter
// - packages/backend/src/lib/orgs-beta.ts    — the ORGS_BETA grant rows
//
// Two rules the teardowns keep, because the rest of the suite depends on them:
// every E2E user ends a run in exactly one organization (their own), and that
// organization ends it with exactly one Owner.
//
// Every key these helpers write or delete is derived from an E2E credential —
// the paid account's org, the paid address, the trial address — so the suite
// owns all three outright and the deletes are unconditional on purpose: a run
// killed mid-test leaves rows behind, and a teardown that insisted on finding
// what it expected would hand the next run a red `beforeAll` instead of a
// repair.

const AWS_REGION = process.env.AWS_REGION ?? 'us-east-2';

/** The four roles, from packages/shared/src/api/org.ts. */
export type OrgRole = 'owner' | 'admin' | 'member' | 'readonly';

/** How long an invitation is good for — INVITE_EXPIRY_DAYS in the shared package. */
const INVITE_EXPIRY_DAYS = 14;

// Key builders, from OrgKeys in packages/backend/src/lib/org-membership.ts.
const orgPk = (orgId: string): string => `ORG#${orgId}`;
const memberSk = (userId: string): string => `MEMBER#${userId}`;
const userPk = (userId: string): string => `USER#${userId}`;
const membershipSk = (orgId: string): string => `MEMBERSHIP#${orgId}`;
const inviteSk = (inviteId: string): string => `INVITE#${inviteId}`;
const inviteTokenPk = (tokenHash: string): string => `INVITETOKEN#${tokenHash}`;
const INVITE_TOKEN_SK = 'LOOKUP';
const INVITE_SK_PREFIX = 'INVITE#';
const MEMBER_SK_PREFIX = 'MEMBER#';
const ORG_META_SK = 'META';
const ORGS_BETA_SK = 'ORGS_BETA';
/** The revision every owner-set write bumps — OWNER_SET_REV_ATTRIBUTE in membership-changes.ts. */
const OWNER_SET_REV_ATTRIBUTE = 'ownerSetRev';

let dynamoClient: DynamoDBClient | null = null;
function getDynamoClient(): DynamoDBClient {
  dynamoClient ??= new DynamoDBClient({ region: AWS_REGION });
  return dynamoClient;
}

function tableName(resource: 'OrgTable' | 'UserInfoTable'): string {
  return (Resource as unknown as Record<string, { name: string }>)[resource].name;
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

/**
 * The organization the user's identity says is theirs.
 *
 * Their own, not "the first one they belong to": these specs put E2E users in a
 * second organization on purpose, and a helper that answered with whichever
 * membership row sorted first would name that one about half the time. The
 * `USER#{userId}/PROFILE` row carries the org signup created for them
 * (packages/backend/src/lib/account-creation.ts), which is the same org the
 * server falls back to when a request names none.
 */
export async function resolvePersonalOrgId(userId: string): Promise<string> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: tableName('UserInfoTable'),
      Key: { pk: { S: userPk(userId) }, sk: { S: 'PROFILE' } },
      ConsistentRead: true,
    }),
  );

  const orgId = Item?.orgId?.S;
  if (!orgId) {
    throw new Error(
      `E2E test user ${userId} has no orgId on their USER#${userId}/PROFILE row, so their own ` +
        `organization cannot be addressed. Check the account's UserInfoTable rows.`,
    );
  }
  return orgId;
}

/**
 * The organization's name, which the transfer dialog makes the caller type and
 * the sidebar renders beside their own.
 */
export async function readOrgName(orgId: string): Promise<string> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: tableName('UserInfoTable'),
      Key: { pk: { S: orgPk(orgId) }, sk: { S: 'PROFILE' } },
      ConsistentRead: true,
    }),
  );

  const name = Item?.name?.S;
  if (!name) {
    throw new Error(`Organization ${orgId} has no name on its ORG#${orgId}/PROFILE row.`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// The organizations beta, which gates creating an invitation
// ---------------------------------------------------------------------------

/**
 * Grant the beta to a whole organization, or to one address.
 *
 * Two rows grant it and presence is the whole grant (lib/orgs-beta.ts). Which
 * one a spec uses is not cosmetic: specs run concurrently against the same
 * staging accounts, so two of them sharing a key would have the first teardown
 * revoke a grant the second still needs. One key per spec keeps them apart.
 */
export async function grantOrgBeta(orgId: string): Promise<void> {
  await putBetaRow(orgPk(orgId));
}

export async function revokeOrgBeta(orgId: string): Promise<void> {
  await deleteBetaRow(orgPk(orgId));
}

export async function grantEmailBeta(email: string): Promise<void> {
  await putBetaRow(allowlistPk(email));
}

export async function revokeEmailBeta(email: string): Promise<void> {
  await deleteBetaRow(allowlistPk(email));
}

/** Lowercased, as the gate looks it up. */
function allowlistPk(email: string): string {
  return `ALLOWLIST#${email.trim().toLowerCase()}`;
}

async function putBetaRow(pk: string): Promise<void> {
  await getDynamoClient().send(
    new PutItemCommand({
      TableName: tableName('UserInfoTable'),
      Item: { pk: { S: pk }, sk: { S: ORGS_BETA_SK }, grantedBy: { S: 'e2e' } },
    }),
  );
}

async function deleteBetaRow(pk: string): Promise<void> {
  await getDynamoClient().send(
    new DeleteItemCommand({
      TableName: tableName('UserInfoTable'),
      Key: { pk: { S: pk }, sk: { S: ORGS_BETA_SK } },
    }),
  );
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/** A token, as newInviteToken mints one: 32 random bytes, base64url. */
function mintInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Its SHA-256, which is the lookup row's address — hashInviteToken. */
function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * An address nobody else's run will collide with, delivered to a mailbox we own.
 *
 * Staging really sends through SendGrid, so an invented domain would bounce.
 * A plus tag on a real E2E account's address reaches the same inbox, and the
 * backend lowercases and trims and nothing else (`normalizeInviteEmail`), so
 * each one is a distinct invitation.
 */
export function uniqueInviteEmail(baseEmail: string): string {
  const [local, domain] = baseEmail.split('@');
  if (!local || !domain) throw new Error(`Not an email address: ${baseEmail}`);
  return `${local}+e2e-invite-${randomUUID()}@${domain}`;
}

export interface SeededInvitation {
  orgId: string;
  inviteId: string;
  /** The raw token, which exists nowhere else — the row keeps only its hash. */
  token: string;
  tokenHash: string;
  email: string;
  emailNorm: string;
  role: OrgRole;
  expiresAt: string;
}

/**
 * Write an invitation the way `POST /api/org/invitations` writes one: the
 * canonical row and its token lookup, in one transaction, both create-only.
 *
 * `invitedBy` has to be a member whose role may still invite `role` when the
 * token is redeemed — the accept transaction carries a `ConditionCheck` on that
 * row (`inviterAuthorityCheck`), so an org's Owner is the safe answer.
 */
export async function seedInvitation({
  orgId,
  email,
  role,
  invitedBy,
}: {
  orgId: string;
  email: string;
  role: OrgRole;
  invitedBy: string;
}): Promise<SeededInvitation> {
  const token = mintInviteToken();
  const tokenHash = hashInviteToken(token);
  const inviteId = randomUUID();
  const emailNorm = email.trim().toLowerCase();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(
    new Date(createdAt).getTime() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const table = tableName('OrgTable');

  await getDynamoClient().send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Put: {
            TableName: table,
            Item: {
              pk: { S: orgPk(orgId) },
              sk: { S: inviteSk(inviteId) },
              email: { S: email },
              emailNorm: { S: emailNorm },
              role: { S: role },
              invitedBy: { S: invitedBy },
              status: { S: 'pending' },
              createdAt: { S: createdAt },
              expiresAt: { S: expiresAt },
              tokenHash: { S: tokenHash },
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: table,
            Item: {
              pk: { S: inviteTokenPk(tokenHash) },
              sk: { S: INVITE_TOKEN_SK },
              orgId: { S: orgId },
              inviteId: { S: inviteId },
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ],
    }),
  );

  return { orgId, inviteId, token, tokenHash, email, emailNorm, role, expiresAt };
}

/**
 * Drop an invitation's rows, whatever state it reached.
 *
 * Unconditional and tolerant of either row being gone: accepting deletes the
 * lookup row and leaves the canonical one marked `accepted`, revoking does the
 * same with `revoked`, and a teardown that insisted on finding both would fail
 * on every invitation the spec actually used.
 */
export async function deleteInvitation({
  orgId,
  inviteId,
  tokenHash,
}: {
  orgId: string;
  inviteId: string;
  tokenHash?: string;
}): Promise<void> {
  const table = tableName('OrgTable');
  await getDynamoClient().send(
    new DeleteItemCommand({
      TableName: table,
      Key: { pk: { S: orgPk(orgId) }, sk: { S: inviteSk(inviteId) } },
    }),
  );
  if (!tokenHash) return;
  await getDynamoClient().send(
    new DeleteItemCommand({
      TableName: table,
      Key: { pk: { S: inviteTokenPk(tokenHash) }, sk: { S: INVITE_TOKEN_SK } },
    }),
  );
}

/**
 * Every invitation an org holds for one address, gone.
 *
 * The teardown for invitations a spec created through the form, whose ids it
 * never learned if the assertion failed before the response arrived. Matched on
 * `emailNorm`, which is the field the server matches on.
 */
export async function deleteInvitationsFor({
  orgId,
  email,
}: {
  orgId: string;
  email: string;
}): Promise<void> {
  const emailNorm = email.trim().toLowerCase();
  for (const item of await queryPartition(orgPk(orgId), INVITE_SK_PREFIX)) {
    if (item.emailNorm?.S !== emailNorm) continue;
    const inviteId = item.sk?.S?.slice(INVITE_SK_PREFIX.length);
    if (!inviteId) continue;
    await deleteInvitation({ orgId, inviteId, tokenHash: item.tokenHash?.S });
  }
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

/**
 * Put a user in an organization: the canonical row and its inverse item, the
 * pair `membershipRows` writes and the pair every reader expects to agree.
 *
 * Not for Owners. The owner set has a counter that moves with it, and a seeded
 * Owner would leave `ownerCount` under-counting until something repaired it —
 * which would quietly defeat the last-Owner guard the counter exists for. A spec
 * that needs a second Owner should reach one the way the product does, through
 * a transfer or a promotion.
 *
 * `membershipRows` conditions its canonical Put on `attribute_not_exists(pk)`
 * and this drops it, the same way {@link setMembershipRole} drops the
 * conditions on `roleChangeItems`. Production's condition is a race backstop
 * behind a pre-read — an accept that loses to another accept loses cleanly — and
 * a seed has the opposite job: it states the membership it wants whatever the
 * last run left. Keeping the condition would turn the residues a killed run
 * leaves into a permanently red `beforeAll` rather than one the next seed
 * repairs.
 *
 * One residue it cannot state its way out of: the seeded member already holding
 * the Owner seat, which is what a killed `transfer.spec.ts` leaves. Writing the
 * non-Owner role over it takes the org's last Owner away while `ownerCount`
 * still says one, and the retried transfer then finds no Owner-only controls to
 * drive. So the seat goes back to `invitedBy` first and the counter is recounted
 * after — a repair the same shape as the spec's own teardown, run at the front
 * of the next run instead of the end of the killed one. Without `invitedBy`
 * there is nobody to hand the seat to, and this throws rather than leaving the
 * org ownerless.
 */
export async function seedMembership({
  orgId,
  userId,
  role,
  invitedBy,
}: {
  orgId: string;
  userId: string;
  role: Exclude<OrgRole, 'owner'>;
  invitedBy?: string;
}): Promise<void> {
  const joinedAt = new Date().toISOString();
  const table = tableName('OrgTable');

  const seatRestored = await restoreOwnerSeatBefore({ orgId, userId, invitedBy });

  await getDynamoClient().send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Put: {
            TableName: table,
            Item: {
              pk: { S: orgPk(orgId) },
              sk: { S: memberSk(userId) },
              role: { S: role },
              joinedAt: { S: joinedAt },
              source: { S: 'invitation' },
              ...(invitedBy ? { invitedBy: { S: invitedBy } } : {}),
            },
          },
        },
        {
          Put: {
            TableName: table,
            Item: {
              pk: { S: userPk(userId) },
              sk: { S: membershipSk(orgId) },
              role: { S: role },
              joinedAt: { S: joinedAt },
            },
          },
        },
      ],
    }),
  );

  // Only when this seed moved the owner set. A seed onto a non-Owner row leaves
  // the owner count exactly where it was, and recounting it would spend a query
  // per `beforeAll` to write back the number already there.
  if (seatRestored) await repairOwnerCount(orgId);
}

/**
 * Put the Owner seat back on the member who granted it, when the seat is on the
 * row about to be seeded.
 *
 * Answers whether it moved anything, which is what tells {@link seedMembership}
 * the counter needs recounting. Reads consistently: the whole point is the state
 * a killed run committed, however recently.
 */
async function restoreOwnerSeatBefore({
  orgId,
  userId,
  invitedBy,
}: {
  orgId: string;
  userId: string;
  invitedBy?: string;
}): Promise<boolean> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: tableName('OrgTable'),
      Key: { pk: { S: orgPk(orgId) }, sk: { S: memberSk(userId) } },
      ConsistentRead: true,
    }),
  );

  if (Item?.role?.S !== 'owner') return false;

  if (!invitedBy) {
    throw new Error(
      `E2E user ${userId} holds the Owner seat in org ${orgId}, and seeding them a lesser role ` +
        `would leave the organization without an Owner. Pass invitedBy so the seat can go back ` +
        `to them, or clear the residue by hand.`,
    );
  }

  await setMembershipRole({ orgId, userId: invitedBy, role: 'owner' });
  return true;
}

/**
 * Take a user out of an organization, both rows.
 *
 * The teardown every spec that seeds a second membership owes the suite: an E2E
 * user left in two organizations renders an org switcher the next run's specs do
 * not expect, and billing-reset would have a second membership to choose from.
 * Unconditional, so it is also the repair for a spec whose own removal step
 * already ran.
 */
export async function deleteMembership({
  orgId,
  userId,
}: {
  orgId: string;
  userId: string;
}): Promise<void> {
  const table = tableName('OrgTable');
  await getDynamoClient().send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Delete: {
            TableName: table,
            Key: { pk: { S: orgPk(orgId) }, sk: { S: memberSk(userId) } },
          },
        },
        {
          Delete: {
            TableName: table,
            Key: { pk: { S: userPk(userId) }, sk: { S: membershipSk(orgId) } },
          },
        },
      ],
    }),
  );
}

/**
 * Put a member back on a role, on both rows.
 *
 * `roleChangeItems` without its conditions: a teardown runs after a test that
 * may have failed anywhere, so it states the role it wants rather than the move
 * it expects to be making. The counter is not touched here — callers that moved
 * the owner set call {@link repairOwnerCount} once, after the last role is back.
 */
export async function setMembershipRole({
  orgId,
  userId,
  role,
}: {
  orgId: string;
  userId: string;
  role: OrgRole;
}): Promise<void> {
  const table = tableName('OrgTable');
  await getDynamoClient().send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Update: {
            TableName: table,
            Key: { pk: { S: orgPk(orgId) }, sk: { S: memberSk(userId) } },
            UpdateExpression: 'SET #role = :role',
            ConditionExpression: 'attribute_exists(pk)',
            ExpressionAttributeNames: { '#role': 'role' },
            ExpressionAttributeValues: { ':role': { S: role } },
          },
        },
        {
          Update: {
            TableName: table,
            Key: { pk: { S: userPk(userId) }, sk: { S: membershipSk(orgId) } },
            UpdateExpression: 'SET #role = :role',
            ExpressionAttributeNames: { '#role': 'role' },
            ExpressionAttributeValues: { ':role': { S: role } },
          },
        },
      ],
    }),
  );
}

/**
 * Set `ownerCount` to the number of Owners the org actually has.
 *
 * Every teardown that put a role back by writing it owes the org this call: the
 * counter is the last-Owner invariant, the transactions that move it are the
 * ones this file bypassed, and an org left with a count that disagrees with its
 * rows is an org whose next removal is decided by arithmetic instead of by
 * membership. `ownerSetRev` moves with it, as it does on every owner-set write,
 * so the drift checker can tell this repair from a reading it took mid-write.
 */
export async function repairOwnerCount(orgId: string): Promise<number> {
  const members = await queryPartition(orgPk(orgId), MEMBER_SK_PREFIX);
  const owners = members.filter((item) => item.role?.S === 'owner').length;

  await getDynamoClient().send(
    new UpdateItemCommand({
      TableName: tableName('OrgTable'),
      Key: { pk: { S: orgPk(orgId) }, sk: { S: ORG_META_SK } },
      UpdateExpression: `SET ownerCount = :count ADD ${OWNER_SET_REV_ATTRIBUTE} :one`,
      ExpressionAttributeValues: { ':count': { N: String(owners) }, ':one': { N: '1' } },
    }),
  );

  return owners;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/** One repair a teardown owes the org, and what to call it when it fails. */
export interface CleanupStep {
  /** What this puts back, named for the message a failure prints. */
  label: string;
  run: () => Promise<unknown>;
}

/**
 * Run every teardown step, including the ones after a step that threw.
 *
 * A teardown is a list of independent repairs — a seat, a membership pair, a
 * counter, a beta grant — and a bare `await` sequence gives the first transient
 * failure the power to abandon all of them. `TransactWriteItems` can be
 * cancelled by throttling or a conflict at any point, and the org the run
 * abandons is the org the next run inherits: two Admins and no Owner fails a
 * `beforeAll`, not the test that caused it.
 *
 * Steps run in the order given, which is the order the invariants need, and
 * every failure is collected and thrown together at the end so a teardown that
 * could not finish still fails the run.
 */
export async function runCleanup(steps: readonly CleanupStep[]): Promise<void> {
  const failures: string[] = [];

  for (const { label, run } of steps) {
    try {
      await run();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Teardown could not finish ${failures.length} step(s):\n  ${failures.join('\n  ')}`,
    );
  }
}

/** Every row under one partition key with one sort-key prefix, paged to the end. */
async function queryPartition(
  pk: string,
  skPrefix: string,
): Promise<Record<string, AttributeValue>[]> {
  const items: Record<string, AttributeValue>[] = [];
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const { Items, LastEvaluatedKey } = await getDynamoClient().send(
      new QueryCommand({
        TableName: tableName('OrgTable'),
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: { ':pk': { S: pk }, ':skPrefix': { S: skPrefix } },
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    items.push(...(Items ?? []));
    startKey = LastEvaluatedKey;
  } while (startKey);

  return items;
}
