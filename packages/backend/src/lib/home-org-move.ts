import {
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { prepareFloorOrg, repointHomeOrg } from './account-creation.ts';
import type { FloorOrgPreparation } from './account-creation.ts';
import { commitAudited } from './audit.ts';
import { getDynamoClient } from './ddb-client.ts';
import { AccountDeletedError, AccountDeletionInProgressError } from './identity-tombstone.ts';
import { listMemberships, OrgKeys } from './org-membership.ts';
import type { OrgMembershipRecord } from './org-membership.ts';
import { isOrgDeleting, orgNotDeletingCheck } from './org-profile.ts';
import { readHomeOrgPointers, readUserProfile } from './user-profile.ts';

/**
 * Where an account goes when it leaves `orgId`, and what stops that leaving it
 * with no org at all: a floor org to create when this is the last membership,
 * or otherwise a check that one of the others is still there when the move
 * commits.
 *
 * The check is what makes the count below safe to act on. Two removals of the
 * same account at once (leaving one org while an admin removes them from the
 * other) each count two memberships and each skip the floor org; without it
 * both would commit and the account would be left in no org. With it, the
 * second to commit finds the membership the first removed, cancels, and a
 * retry counts again.
 *
 * The check comes with a repoint of each home-org pointer that names the org
 * being left, onto the org that remains.
 *
 * An org being deleted does not count as one that remains. Its membership rows
 * outlive most of its teardown, but a home moved onto it stays fenced once the
 * teardown is done, with nothing left to move it again. So the remaining org is
 * one that is not deleting, checked again when the move commits, and an
 * account whose other orgs are all deleting gets a floor org like one with
 * none.
 *
 * Neither, when this is the last membership but nothing here can name the row
 * that needs repointing.
 *
 * `listMemberships` is read fresh rather than reused from anywhere else: it is
 * the strongly-consistent count of every org this account belongs to right
 * now, and the move about to happen is not among them yet.
 */
export async function planHomeOrgMove({
  userId,
  orgId,
  name,
  email,
}: {
  userId: string;
  orgId: string;
  name?: string;
  email?: string;
}): Promise<HomeOrgMovePlan> {
  const memberships = await listMemberships(userId);
  const remaining = await findLiveOrg(
    memberships.filter((membership) => membership.orgId !== orgId),
  );

  // Throws on a failed read rather than answering "no sub": this runs before
  // any key is revoked or row written, so a read error stops the move here
  // instead of letting it leave the account with no org at all, or homed in
  // an org it no longer belongs to.
  const { sub, profileOrgId, identityOrgId } = await readHomeOrgPointers(userId);

  if (remaining) {
    return {
      remainingOrgId: remaining.orgId,
      remainingItems: [
        membershipStandsCheck(userId, remaining.orgId),
        orgNotDeletingCheck(remaining.orgId),
        ...(profileOrgId === orgId
          ? [repointHomeOrg({ pk: `USER#${userId}`, sk: 'PROFILE' }, remaining.orgId, orgId)]
          : []),
        ...(sub && identityOrgId === orgId
          ? [repointHomeOrg({ pk: `SUB#${sub}`, sk: 'IDENTITY' }, remaining.orgId, orgId)]
          : []),
      ],
    };
  }

  if (!sub) {
    console.error('[home-org-move] Account has no sub on its profile, leaving it without an org', {
      userId,
      orgId,
    });
    return {};
  }

  const floorOrg = await prepareFloorOrg({
    userId,
    sub,
    homeOrgIds: { profile: profileOrgId, identity: identityOrgId },
    name,
    email,
  });
  return { floorOrg };
}

/**
 * What keeps the account somewhere to log in to: a floor org when this is its
 * last membership, or otherwise the org that remains and the items that hold
 * it there.
 */
export interface HomeOrgMovePlan {
  floorOrg?: FloorOrgPreparation;
  remainingOrgId?: string;
  remainingItems?: TransactWriteItem[];
}

/**
 * Moves an account whose home org's deletion has finished off that org, and
 * returns where it now lives.
 *
 * The deletion moves its surviving members at the start of its pass, so after
 * it finishes only an account homed there before that existed is left behind:
 * fenced on every request by an org that is gone, with nothing else to move it.
 *
 * A move that loses a race (another request moved it first, or the org it
 * chose started deleting) answers "try again", and the retry reads where the
 * account is now.
 */
export async function moveHomeOffDeletedOrg({
  userId,
  orgId,
}: {
  userId: string;
  orgId: string;
}): Promise<string> {
  const profile = await readUserProfile(userId, { consistentRead: true });
  const plan = await planHomeOrgMove({
    userId,
    orgId,
    name: profile?.name,
    email: profile?.email,
  });
  try {
    if (plan.floorOrg) {
      await commitAudited({ items: plan.floorOrg.items, event: plan.floorOrg.event });
      return plan.floorOrg.orgId;
    }
    if (plan.remainingOrgId && plan.remainingItems) {
      await getDynamoClient().send(
        new TransactWriteItemsCommand({ TransactItems: plan.remainingItems }),
      );
      return plan.remainingOrgId;
    }
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      throw new AccountDeletionInProgressError('organization');
    }
    throw err;
  }
  throw new AccountDeletedError();
}

/**
 * The first of `memberships` whose org is not being deleted. Consistent reads,
 * because a deletion confirmed moments ago is the case this exists to catch.
 */
async function findLiveOrg(
  memberships: OrgMembershipRecord[],
): Promise<OrgMembershipRecord | undefined> {
  for (const membership of memberships) {
    if (!(await isOrgDeleting(membership.orgId, { consistent: true }))) return membership;
  }
  return undefined;
}

/** A condition that the account's membership of `orgId` still stands. */
function membershipStandsCheck(userId: string, orgId: string): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: Resource.OrgTable.name,
      Key: { pk: { S: OrgKeys.userPk(userId) }, sk: { S: OrgKeys.membershipSk(orgId) } },
      ConditionExpression: 'attribute_exists(pk)',
    },
  };
}
