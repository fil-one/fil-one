import { QueryCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { S3Region, keySurvival } from '@filone/shared';
import type { ExcessKeyPermission, OrgRole } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { AccessKeyKeys } from './dynamo-records.js';
import type { AccessKeyRecord } from './dynamo-records.js';

/**
 * An org's access-key rows, and which of them a member could still mint.
 *
 * Every key row lives in the same `ORG#{orgId}` partition whatever region holds
 * the credential, and `UserInfoTable` carries no secondary index, so asking
 * "which keys does this member hold" is one paged Query and a filter in memory.
 * The region on the row decides which orchestrator revokes it, nothing else.
 */

/** One key row, as the revocation pass and the preview both read it. */
export interface MemberKey {
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
}

/** A key the member could no longer mint, and why. */
export interface DoomedKey extends MemberKey {
  reason: 'role_cannot_mint' | 'permissions_unrecorded' | 'exceeds_role';
  /** The permissions above the new role, when that is what condemned it. */
  excess: ExcessKeyPermission[];
}

export interface KeyReview {
  /** Revoked when the change goes through, in the order the partition returned. */
  doomed: DoomedKey[];
  /** The member's keys that stay live. */
  survivingCount: number;
  /**
   * Rows in the org with no recorded creator, which no role change touches.
   * Reported so an admin reading a short list knows what it leaves out.
   */
  unattributedCount: number;
}

/**
 * Every access-key row in the org, following `LastEvaluatedKey` to the end.
 *
 * The revocation pass has to see all of them: a key it misses is a credential
 * that outlives the authority to mint it, which is the whole thing this
 * prevents.
 */
export async function listOrgAccessKeys(orgId: string): Promise<MemberKey[]> {
  const rows: MemberKey[] = [];
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
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );

    for (const item of result.Items ?? [])
      rows.push(toMemberKey(unmarshall(item) as Partial<AccessKeyRecord>));
    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return rows;
}

/**
 * Which of `userId`'s keys survive them moving to `role`.
 *
 * Attribution is `createdBy` alone. `withinScope` answers a different question,
 * who may see a key, and its `recovered` clause would hide from this pass
 * exactly the rows that have to be revoked.
 */
export function reviewKeysForRole(
  rows: readonly MemberKey[],
  userId: string,
  role: OrgRole,
): KeyReview {
  const review: KeyReview = { doomed: [], survivingCount: 0, unattributedCount: 0 };

  for (const row of rows) {
    if (!row.createdBy) {
      review.unattributedCount += 1;
      continue;
    }
    if (row.createdBy !== userId) continue;

    const survival = keySurvival(role, row);
    if (survival.survives) {
      review.survivingCount += 1;
      continue;
    }
    review.doomed.push({
      ...row,
      reason: survival.reason,
      excess: survival.reason === 'exceeds_role' ? survival.excess : [],
    });
  }

  return review;
}

/** {@link listOrgAccessKeys} and {@link reviewKeysForRole} in one call. */
export async function keysExceedingRole(
  orgId: string,
  userId: string,
  role: OrgRole,
): Promise<KeyReview> {
  return reviewKeysForRole(await listOrgAccessKeys(orgId), userId, role);
}

function toMemberKey(record: Partial<AccessKeyRecord>): MemberKey {
  const sk = record.sk ?? '';
  return {
    id: sk.slice(AccessKeyKeys.keySkPrefix().length),
    keyName: record.keyName ?? '',
    // Rows written before multi-region routing carry no region. Those predate
    // FTH, so they belong to Aurora.
    region: record.region ?? S3Region.EuWest1,
    createdAt: record.createdAt ?? '',
    ...(record.accessKeyId ? { accessKeyId: record.accessKeyId } : {}),
    ...(record.createdBy ? { createdBy: record.createdBy } : {}),
    ...(record.permissions ? { permissions: record.permissions } : {}),
    ...(record.granularPermissions ? { granularPermissions: record.granularPermissions } : {}),
  };
}
