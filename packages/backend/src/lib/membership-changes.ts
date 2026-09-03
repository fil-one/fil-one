import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { OrgRole, canManageTargetRole, roleNarrows } from '@filone/shared';
import type { OrgMembershipSource } from '@filone/shared';
import { OrgKeys } from './org-membership.js';

/**
 * The writes that change who is in an organization and what they may do.
 *
 * Every one of them is a transaction item rather than a call, because none of
 * these changes is ever a single write: the canonical `MEMBER#` row and its
 * `MEMBERSHIP#` inverse item must agree about a role, the owner set has a counter
 * that has to move with it, and an audit event rides along
 * (`commitAudited`, `lib/audit.ts`). Handlers assemble the items, name the ones
 * whose conditions they care about, and hand the lot to one transaction.
 *
 * Three invariants live here rather than in the handlers:
 *
 * - **Canonical and inverse move together.** Both are written on create, delete,
 *   and every role change, so `MeResponse.memberships` can never show a role the
 *   member no longer holds.
 * - **The last Owner cannot leave.** `ownerCount` on `ORG#{orgId}/META` carries
 *   the delta, and the guard is that same update's condition — DynamoDB permits
 *   one operation per item per transaction, so the check and the decrement have
 *   to be the same operation.
 * - **An invitation does not outlive its issuer's authority.** The accept
 *   transaction carries a `ConditionCheck` on the inviter's membership row,
 *   expressed in the roles the registry says may invite the role in question.
 */

/** What a membership row records about how the member arrived. */
export interface MembershipOrigin {
  joinedAt: string;
  source: OrgMembershipSource;
  /** The member who issued the invitation, when `source` is `invitation`. */
  invitedBy?: string;
}

/**
 * A new membership: the canonical row and its inverse item.
 *
 * The canonical row is create-only, which is how an accept that races another
 * accept of the same invitation loses cleanly instead of overwriting a role
 * somebody already holds. The inverse item is not: it carries no authority, and
 * a stale one left behind by an interrupted write should be corrected rather than
 * be the reason a member cannot join.
 */
export function membershipRows({
  orgId,
  userId,
  role,
  origin,
}: {
  orgId: string;
  userId: string;
  role: OrgRole;
  origin: MembershipOrigin;
}): TransactWriteItem[] {
  const tableName = Resource.OrgTable.name;

  return [
    {
      Put: {
        TableName: tableName,
        Item: {
          pk: { S: OrgKeys.orgPk(orgId) },
          sk: { S: OrgKeys.memberSk(userId) },
          role: { S: role },
          joinedAt: { S: origin.joinedAt },
          source: { S: origin.source },
          ...(origin.invitedBy ? { invitedBy: { S: origin.invitedBy } } : {}),
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: {
          pk: { S: OrgKeys.userPk(userId) },
          sk: { S: OrgKeys.membershipSk(orgId) },
          role: { S: role },
          joinedAt: { S: origin.joinedAt },
        },
      },
    },
  ];
}

/**
 * A role change, on both rows.
 *
 * The canonical row's update is conditional on the role the caller read, so two
 * concurrent conflicting changes cannot double-apply: the loser cancels and its
 * handler says so. The inverse item's update is not conditional on a role — it is
 * a denormalized copy, and an update that also repairs a copy that had drifted is
 * the outcome we want.
 *
 * That repair is why the inverse carries no condition of its own, and why every
 * caller carries the org-deletion fence instead. `deletion-scrub.ts` deletes the
 * inverse items before the canonical member rows, so a change landing in that
 * gap passes the canonical row's condition and an unconditional Update RECREATES
 * an inverse item the scrub has already walked past — a membership in a torn-down
 * org, showing in `/me` and counted by the deletion census, that nothing revisits.
 * Conditioning the inverse on the canonical row is not open to us: DynamoDB
 * permits one operation per item per transaction, and the canonical row already
 * holds the Update. The fence is a different item and refuses the whole
 * transaction, which keeps the drift repair and closes the gap.
 */
export function roleChangeItems({
  orgId,
  userId,
  fromRole,
  toRole,
}: {
  orgId: string;
  userId: string;
  fromRole: OrgRole;
  toRole: OrgRole;
}): [membership: TransactWriteItem, inverse: TransactWriteItem] {
  const tableName = Resource.OrgTable.name;

  return [
    {
      Update: {
        TableName: tableName,
        Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.memberSk(userId) } },
        UpdateExpression: 'SET #role = :role',
        ConditionExpression: 'attribute_exists(pk) AND #role = :fromRole',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':role': { S: toRole }, ':fromRole': { S: fromRole } },
      },
    },
    {
      Update: {
        TableName: tableName,
        Key: { pk: { S: OrgKeys.userPk(userId) }, sk: { S: OrgKeys.membershipSk(orgId) } },
        UpdateExpression: 'SET #role = :role',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':role': { S: toRole } },
      },
    },
  ];
}

/**
 * Removal, on both rows.
 *
 * The canonical delete carries the role the caller read, the same condition
 * {@link roleChangeItems} puts on a role change, and for the same reason: the
 * transaction's `ownerCount` delta is decided from that reading, and a
 * promotion committing in the gap touches only the member row and META —
 * neither one an item this transaction conflicts on. Without the condition an
 * Owner is deleted with no decrement, the counter overcounts, and
 * `ownerCount > :one` then passes for the genuine last Owner.
 *
 * `attribute_exists(pk)` stays alongside it so a removal of somebody already
 * gone is a clean 404 rather than a silent success. The inverse delete is
 * unconditional, because a member whose inverse item is missing must still be
 * removable.
 */
export function membershipDeleteItems({
  orgId,
  userId,
  fromRole,
}: {
  orgId: string;
  userId: string;
  fromRole: OrgRole;
}): TransactWriteItem[] {
  const tableName = Resource.OrgTable.name;

  return [
    {
      Delete: {
        TableName: tableName,
        Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.memberSk(userId) } },
        ConditionExpression: 'attribute_exists(pk) AND #role = :fromRole',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':fromRole': { S: fromRole } },
      },
    },
    {
      Delete: {
        TableName: tableName,
        Key: { pk: { S: OrgKeys.userPk(userId) }, sk: { S: OrgKeys.membershipSk(orgId) } },
      },
    },
  ];
}

/** How the owner set moved: gained one, lost one, or swapped one for another. */
export type OwnerCountDelta = 'increment' | 'decrement' | 'unchanged';

/**
 * Bumped by every owner-set transaction, including the transfer that leaves the
 * count where it was.
 *
 * The drift checker's recount pages a Query, and DynamoDB gives no snapshot
 * across pages: a transfer committing between two of them is observed half
 * applied, as zero Owners or two. The counter alone cannot say so, because a
 * transfer's delta is zero and `ownerCount = :stale` still holds — so the repair
 * would write the transient count and, at two, defeat the last-Owner guard the
 * counter exists for. A revision that moves on every owner-set write is what the
 * recount holds its reading against.
 *
 * `ADD` rather than `SET ... + :one`, so a META row written before this
 * attribute existed starts at one instead of failing the update.
 */
export const OWNER_SET_REV_ATTRIBUTE = 'ownerSetRev';
const OWNER_SET_REV_CLAUSE = ` ADD ${OWNER_SET_REV_ATTRIBUTE} :one`;

/**
 * The one update every owner-set transaction carries.
 *
 * `decrement` is where the last-Owner invariant is enforced, and it is enforced
 * as this update's own condition (`ownerCount > :one`) because DynamoDB allows a
 * single operation per item per transaction — a separate `ConditionCheck` on the
 * same META row would make the transaction invalid rather than safer.
 *
 * `unchanged` still writes: ownership transfer promotes and demotes in one
 * transaction, and touching the counter with a net-zero update is what makes the
 * META row part of that transaction, so a concurrent promotion cannot interleave
 * with it.
 *
 * Every branch conditions on the counter existing. An org whose META row is
 * missing is a conversion gap, and inventing a counter for it would quietly set
 * the invariant to whatever this one transaction happened to know.
 */
export function ownerCountItem(orgId: string, delta: OwnerCountDelta): TransactWriteItem {
  const key = { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.orgMetaSk() } };
  const base = { TableName: Resource.OrgTable.name, Key: key };

  if (delta === 'increment') {
    return {
      Update: {
        ...base,
        UpdateExpression: `SET ownerCount = ownerCount + :one${OWNER_SET_REV_CLAUSE}`,
        ConditionExpression: 'attribute_exists(ownerCount)',
        ExpressionAttributeValues: { ':one': { N: '1' } },
      },
    };
  }

  if (delta === 'decrement') {
    return {
      Update: {
        ...base,
        UpdateExpression: `SET ownerCount = ownerCount - :one${OWNER_SET_REV_CLAUSE}`,
        // The whole last-Owner guard, in one place: an org at one Owner cancels
        // the transaction that would take it to zero.
        ConditionExpression: 'ownerCount > :one',
        ExpressionAttributeValues: { ':one': { N: '1' } },
      },
    };
  }

  return {
    Update: {
      ...base,
      UpdateExpression: `SET ownerCount = ownerCount + :zero${OWNER_SET_REV_CLAUSE}`,
      ConditionExpression: 'attribute_exists(ownerCount)',
      ExpressionAttributeValues: { ':zero': { N: '0' }, ':one': { N: '1' } },
    },
  };
}

/** How the owner set moves when a member goes from one role to another. */
export function ownerCountDeltaFor(fromRole: OrgRole, toRole: OrgRole): OwnerCountDelta {
  if (fromRole === toRole) return 'unchanged';
  if (toRole === OrgRole.Owner) return 'increment';
  if (fromRole === OrgRole.Owner) return 'decrement';
  return 'unchanged';
}

/**
 * Assert, inside the transaction, that the inviter still holds a role that may
 * invite the role being accepted.
 *
 * An invitation must not outlive its issuer's authority: an Admin demoted after
 * inviting cannot mint members through invitations still in flight. Demotion and
 * removal also revoke that member's pending invitations, so this is the backstop
 * for the window between the two — and for an invitation whose issuer was
 * demoted by a path that never saw it.
 *
 * The admissible roles come from the registry rather than from a rank
 * comparison, so the matrix stays the single answer to "who may invite an
 * Owner": `canManageTargetRole` is asked of each role, and the condition is the
 * resulting set.
 */
export function inviterAuthorityCheck({
  orgId,
  invitedBy,
  invitedRole,
}: {
  orgId: string;
  invitedBy: string;
  invitedRole: OrgRole;
}): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: Resource.OrgTable.name,
      Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.memberSk(invitedBy) } },
      ...roleIsOneOf((role) => canManageTargetRole(role, invitedRole)),
    },
  };
}

/**
 * Assert, inside the transaction, that the creator still holds a role that
 * mints what the cap allowed.
 *
 * The mint path evaluates its permission cap against the creator's role and
 * then writes the key row, and a role narrowing between the two would leave a
 * key above the role that authorized it. The narrowing revokes what it finds,
 * so this closes the window where a row lands after its listing: the row cannot
 * be written unless the role on file still holds everything the cap ran
 * against. A widening strands nothing, so a promotion landing in the same gap
 * is admitted rather than made to cancel a key the new role covers.
 *
 * The admissible roles are asked of `roleNarrows` one by one, the way
 * {@link inviterAuthorityCheck} asks the registry, so the permission sets stay
 * the single answer to what a role may mint.
 */
export function creatorRoleStillMintsCheck({
  orgId,
  userId,
  role,
}: {
  orgId: string;
  userId: string;
  /** The role the cap was evaluated against. */
  role: OrgRole;
}): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: Resource.OrgTable.name,
      Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.memberSk(userId) } },
      ...roleIsOneOf((current) => !roleNarrows(role, current)),
    },
  };
}

/**
 * The condition that a membership row exists and its role is one a predicate
 * admits, as an `IN` set in registry order: `:role0`, `:role1`, and so on.
 *
 * A predicate admitting nothing would build `#role IN ()`, which DynamoDB
 * rejects as a malformed expression rather than reporting an unmet condition —
 * so a caller must always admit at least one role. Both do, structurally rather
 * than by luck: no role narrows relative to itself, and every invitable role
 * has some role that may invite it.
 */
function roleIsOneOf(admits: (role: OrgRole) => boolean) {
  const values = Object.fromEntries(
    Object.values(OrgRole)
      .filter(admits)
      .map((role, index) => [`:role${index}`, { S: role }]),
  );

  return {
    ConditionExpression: `attribute_exists(pk) AND #role IN (${Object.keys(values).join(', ')})`,
    ExpressionAttributeNames: { '#role': 'role' },
    ExpressionAttributeValues: values,
  };
}

/**
 * Which of a transaction's items failed their CONDITIONS, by the caller's own
 * names for them.
 *
 * DynamoDB reports cancellation reasons positionally, and a handler that indexed
 * into that array would answer 404 for the wrong reason the moment somebody
 * inserted an item ahead of the one it meant. Naming the items keeps the mapping
 * honest: the caller passes the same labels in the same order as the items, and
 * asks which names cancelled.
 *
 * Only `ConditionalCheckFailed` counts. Every caller here turns a named item
 * into a statement about the world — "this org has one Owner", "this person is
 * not a member", "somebody accepted first" — and those statements are true only
 * of a guard that fired. A `TransactionConflict` or a throttle cancels the same
 * item and means the opposite: the write did not happen, try again. Reported as
 * a condition failure, a conflict on the META row would tell an Owner they are
 * the last one and a conflict on a membership row would tell a member they do
 * not exist.
 *
 * So anything else leaves the list empty and the caller's `throw err` stands,
 * which is the honest answer for a transient failure: an error the client
 * retries, not a verdict.
 */
export function cancelledLabels(err: unknown, labels: readonly string[]): string[] {
  if (!(err instanceof TransactionCanceledException)) return [];

  return (err.CancellationReasons ?? []).flatMap((reason, index) =>
    reason.Code === CONDITION_FAILED ? [labels[index] ?? `item${index}`] : [],
  );
}

/** The one cancellation reason that means a condition we wrote was not met. */
const CONDITION_FAILED = 'ConditionalCheckFailed';
