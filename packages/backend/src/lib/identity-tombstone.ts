import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import type { UserInfo } from './user-context.js';

/**
 * True when the identity behind `userInfo.sub` is gone (FIL-112).
 *
 * Why this is a reliable *post-write* verification, not just a pre-check:
 * account deletion arms the SUB# tombstone (`SET deleted = true`) at confirm
 * time, strictly BEFORE the billing row is purged, and the tombstone is
 * retained forever (with `userId` REMOVEd). So any writer that writes first and
 * then reads this consistently either sees a live identity — in which case the
 * purge had not yet started and will therefore sweep the just-written row — or
 * sees the tombstone and can compensate its own write. Either way a
 * post-teardown resurrection cannot survive.
 *
 * A missing row counts as tombstoned: the deletion-confirm handler upserts the
 * SUB# row, so an absent row means the identity never existed at all.
 *
 * ConsistentRead is mandatory. The auth middleware's tombstone gate ran earlier
 * on an eventually-consistent read, which is exactly the window this call
 * exists to close.
 */
export async function isIdentityTombstoned(userInfo: Pick<UserInfo, 'sub'>): Promise<boolean> {
  const identity = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `SUB#${userInfo.sub}` }, sk: { S: 'IDENTITY' } },
      ConsistentRead: true,
    }),
  );
  return identity.Item?.deleted?.BOOL === true || !identity.Item?.userId?.S;
}
