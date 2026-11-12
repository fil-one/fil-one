import { QueryCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
  NO_ROLE,
  S3Region,
  auditKeyIdSuffix,
  canRetainAccessKey,
  roleHasPermission,
} from '@filone/shared';
import type {
  AccessKeyRevocationReason,
  AccessKeySummary,
  ExcessKeyPermission,
  OrgRole,
} from '@filone/shared';
import { Resource } from 'sst';
import { readAccessKeyMintSeq } from './access-key-mint-seq.ts';
import type { KeyMintFence } from './access-key-mint-seq.ts';
import { getDynamoClient } from './ddb-client.ts';
import { AccessKeyKeys, DEFAULT_ACCESS_KEY_REGION } from './dynamo-records.ts';
import type { AccessKeyRecord } from './dynamo-records.ts';

/**
 * An org's access-key rows, and which of them a member could still mint.
 *
 * Every key row lives in the same `ORG#{orgId}` partition whatever region holds
 * the credential, and `UserInfoTable` carries no secondary index, so asking
 * "which keys does this member hold" is one paged Query and a filter in memory.
 * The region on the row decides which orchestrator revokes it, nothing else.
 */

/** One access-key row, as the revocation pass and the preview both read it. */
export interface MemberAccessKey {
  /** The orchestrator's id for the key, which is what `deleteAccessKey` takes. */
  id: string;
  keyName: string;
  /** What the console lists. Absent only on rows written before it was stored. */
  accessKeyId?: string;
  region: S3Region;
  createdAt: string;
  createdBy?: string;
  permissions?: AccessKeyRecord['permissions'];
  granularPermissions?: AccessKeyRecord['granularPermissions'];
  /** Set on a principal-bound key. */
  principalId?: string;
}

/** A key the member could no longer mint, and why. */
export interface AccessKeyToRevoke extends MemberAccessKey {
  reason: AccessKeyRevocationReason;
  /** The permissions above the new role, when that is what condemned it. */
  excess: ExcessKeyPermission[];
}

export interface AccessKeyRoleChangeReview {
  /** Revoked when the change goes through, in the order the partition returned. */
  keysToRevoke: AccessKeyToRevoke[];
  /** The member's keys that stay live. */
  retainedKeyCount: number;
  /**
   * Rows in the org with no recorded creator, which no role change touches.
   * Reported so an admin reading a short list knows what it leaves out.
   */
  unattributedKeyCount: number;
}

/**
 * Every access-key row in the org, following `LastEvaluatedKey` to the end.
 *
 * The revocation pass has to see all of them: a key it misses is a credential
 * that outlives the authority to mint it, which is the whole thing this
 * prevents. That is also why the read is strongly consistent rather than the
 * cheaper default.
 *
 * Internal to this module; exported for direct testing.
 */
export async function listOrgAccessKeys(orgId: string): Promise<MemberAccessKey[]> {
  const accessKeys: MemberAccessKey[] = [];
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await getDynamoClient().send(
      new QueryCommand({
        TableName: Resource.UserInfoTable.name,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': { S: AccessKeyKeys.orgPk(orgId) },
          ':skPrefix': { S: AccessKeyKeys.keySkPrefix() },
        },
        // Strongly consistent, on every page. This listing decides what gets
        // revoked, and a default Query may not yet show a key minted moments
        // before the change: the row would survive both passes, leaving a
        // credential above the role that authorized it.
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );

    for (const item of result.Items ?? [])
      accessKeys.push(toMemberAccessKey(unmarshall(item) as Partial<AccessKeyRecord>));
    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return accessKeys;
}

/**
 * Which of `userId`'s keys survive them moving to `role`.
 *
 * Attribution is `createdBy` alone. `withinScope` answers a different question,
 * who may see a key, and its `recovered` clause would hide from this pass
 * exactly the rows that have to be revoked.
 *
 * Internal to this module; exported for direct testing.
 */
export function reviewAccessKeysForRole(
  accessKeys: readonly MemberAccessKey[],
  userId: string,
  role: OrgRole | typeof NO_ROLE,
): AccessKeyRoleChangeReview {
  const review: AccessKeyRoleChangeReview = {
    keysToRevoke: [],
    retainedKeyCount: 0,
    unattributedKeyCount: 0,
  };

  for (const accessKey of accessKeys) {
    if (!accessKey.createdBy) {
      review.unattributedKeyCount += 1;
      continue;
    }
    if (accessKey.createdBy !== userId) continue;
    // A principal-bound key carries no permissions of its own: the bucket
    // policy statements naming its principal are its whole authority, and
    // nothing on the role-change path rewrites them. So the only question the
    // new role can answer about it is the one `canRetainAccessKey` asks first —
    // could this role mint such a key at all. A role that could not leaves a
    // holder who can neither list nor revoke it (`keys.manage_own` is what
    // scopes both) while it keeps signing whatever those policies grant: a
    // demotion to ReadOnly would otherwise keep working PutObject and
    // DeleteObject. NO_ROLE holds no permission either, so removal still
    // revokes, as it did before.
    if (accessKey.principalId) {
      if (roleHasPermission(role, 'keys.create')) {
        review.retainedKeyCount += 1;
      } else {
        review.keysToRevoke.push({ ...accessKey, reason: 'role_cannot_mint', excess: [] });
      }
      continue;
    }

    const retention = canRetainAccessKey(role, accessKey);
    if (retention.retained) {
      review.retainedKeyCount += 1;
      continue;
    }
    review.keysToRevoke.push({
      ...accessKey,
      reason: retention.reason,
      excess: retention.reason === 'exceeds_role' ? retention.excess : [],
    });
  }

  return review;
}

/** {@link listOrgAccessKeys} and {@link reviewAccessKeysForRole} in one call. */
export async function reviewMemberAccessKeysForRole(
  orgId: string,
  userId: string,
  role: OrgRole | typeof NO_ROLE,
): Promise<AccessKeyRoleChangeReview> {
  return reviewAccessKeysForRole(await listOrgAccessKeys(orgId), userId, role);
}

/**
 * The same review, plus the fence a membership change carries to prove the
 * listing is still current (`lib/access-key-mint-seq.ts`).
 *
 * The two reads are here rather than at the call sites because their order is
 * the whole point: the sequence first, then the listing. Reversed, a mint
 * landing between them is counted by the fence and missing from the list.
 *
 * Removal asks about `NO_ROLE`, the narrowing to nothing: no role is left to
 * mint under, so every attributed key is revoked. A role that keeps
 * `keys.create` keeps the member's principal-bound keys; one that does not —
 * `NO_ROLE` and ReadOnly — takes them, since nothing here rewrites the bucket
 * policies that are their authority. Rows with no recorded creator are outside
 * this rule, as they are outside every other.
 */
export async function reviewKeysForRoleChange(
  orgId: string,
  userId: string,
  role: OrgRole | typeof NO_ROLE,
): Promise<{ keysToRevoke: AccessKeyToRevoke[]; fence: KeyMintFence }> {
  const mintSeq = await readAccessKeyMintSeq({ orgId, userId });
  const { keysToRevoke } = await reviewMemberAccessKeysForRole(orgId, userId, role);
  return { keysToRevoke, fence: { userId, mintSeq } };
}

/**
 * A key a change will revoke, as the console lists it and the audit summary
 * names it.
 *
 * The access key id is cut to the four characters the console already shows: a
 * whole `AKIA…` in a response body or a log line is a credential half nobody
 * needs to recognize a key by.
 */
export function summarizeAccessKey(key: AccessKeyToRevoke): AccessKeySummary {
  return {
    id: key.id,
    keyName: key.keyName,
    ...(key.accessKeyId ? { accessKeyIdSuffix: auditKeyIdSuffix('s3', key.accessKeyId) } : {}),
    region: key.region,
    createdAt: key.createdAt,
    reason: key.reason,
    excess: key.excess.map(({ keyPermission }) => keyPermission),
  };
}

function toMemberAccessKey(record: Partial<AccessKeyRecord>): MemberAccessKey {
  const sk = record.sk ?? '';
  return {
    id: sk.slice(AccessKeyKeys.keySkPrefix().length),
    keyName: record.keyName ?? '',
    region: record.region ?? DEFAULT_ACCESS_KEY_REGION,
    createdAt: record.createdAt ?? '',
    ...(record.accessKeyId ? { accessKeyId: record.accessKeyId } : {}),
    ...(record.createdBy ? { createdBy: record.createdBy } : {}),
    ...(record.permissions ? { permissions: record.permissions } : {}),
    ...(record.granularPermissions ? { granularPermissions: record.granularPermissions } : {}),
    ...(record.principalId ? { principalId: record.principalId } : {}),
  };
}
