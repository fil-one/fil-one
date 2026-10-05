import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.ts';
import { OrgKeys } from './org-membership.ts';

/**
 * The member's access-key mint sequence: how many key rows have landed for them.
 *
 * It serializes two flows that otherwise share no item. A narrowing lists a
 * member's keys, revokes what the new role cannot hold, then writes the role; a
 * mint writes its key row under a condition on the creator's role. Neither side
 * can see the schedule where the row lands and the mint's own re-read completes
 * before the role write commits, so the narrowing would act on a listing that is
 * already stale. This row is the item they both touch: the mint bumps it, and
 * the narrowing asserts it has not moved since it listed.
 *
 * A sequence, not a count of live keys: only equality is ever asked of it, and
 * it outlives the membership: a member who left and rejoined must not be able to
 * satisfy a fence read before they went. Org teardown collects the row
 * (`lib/deletion-scrub.ts`).
 */

/** Whose sequence, in which org. */
interface MemberRef {
  orgId: string;
  userId: string;
}

/** The sequence a change's key listing was taken against. */
export interface KeyMintFence {
  userId: string;
  /** Undefined when no key has ever been minted, which is the row's absence. */
  mintSeq: number | undefined;
}

const seqKey = ({ orgId, userId }: MemberRef) => ({
  pk: { S: OrgKeys.orgPk(orgId) },
  sk: { S: OrgKeys.accessKeyMintSeqSk(userId) },
});

/** Read before the keys are listed, which `reviewKeysForRoleChange` is what keeps. */
export async function readAccessKeyMintSeq(member: MemberRef): Promise<number | undefined> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.OrgTable.name,
      Key: seqKey(member),
      ConsistentRead: true,
    }),
  );

  const stored = Item?.mintSeq?.N;
  if (stored === undefined) return undefined;
  const mintSeq = Number(stored);
  return Number.isFinite(mintSeq) ? mintSeq : undefined;
}

/** Advance the sequence. `ADD` creates the row on the first mint. */
export function accessKeyMintSeqItem(member: MemberRef): TransactWriteItem {
  return {
    Update: {
      TableName: Resource.OrgTable.name,
      Key: seqKey(member),
      UpdateExpression: 'ADD mintSeq :one',
      ExpressionAttributeValues: { ':one': { N: '1' } },
    },
  };
}

/**
 * Assert the sequence has not moved since it was read. An absent `mintSeq` is
 * asserted as the row's absence, which a first-ever mint breaks by creating it.
 */
export function accessKeyMintSeqUnchangedCheck(
  orgId: string,
  { userId, mintSeq }: KeyMintFence,
): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: Resource.OrgTable.name,
      Key: seqKey({ orgId, userId }),
      ...(mintSeq === undefined
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : {
            ConditionExpression: 'attribute_exists(pk) AND mintSeq = :seen',
            ExpressionAttributeValues: { ':seen': { N: String(mintSeq) } },
          }),
    },
  };
}
