import { GetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import type { UserInfo } from './user-context.js';

/**
 * What the `SUB#{sub}/IDENTITY` row says about an identity (FIL-112).
 *
 * - `live` — no deletion has been confirmed for this identity.
 * - `deleting` — a teardown is armed and in flight.
 * - `deleted` — the teardown reached the purge, or the identity never existed.
 */
export type IdentityState = 'live' | 'deleting' | 'deleted';

/**
 * Classify the row. Two writes make the three states distinguishable without a
 * second read: `applyDeletionGuards` arms `deleted = true` at confirm time and
 * leaves `userId` alone, and the purge later `REMOVE`s `userId` (with `orgId`
 * and the other PII-adjacent attributes). So an armed row that still carries a
 * `userId` is mid-teardown, and one without is past the purge.
 *
 * An absent row is `deleted`, NOT `deleting`: the confirm handler upserts this
 * row, so no row at all means the identity never existed, and there is no
 * evidence of an in-flight teardown to report.
 *
 * The classifier is not exact in one direction, which is fine because both
 * non-live states answer 410: `applyDeletionGuards`' upsert is unconditional, so
 * on the rare path where it *creates* the row rather than updating one, an
 * in-flight teardown has no `userId` and classifies as `deleted`.
 */
export function classifyIdentityRow(
  item: Record<string, AttributeValue> | undefined,
): IdentityState {
  if (!item) return 'deleted';
  const armed = item.deleted?.BOOL === true;
  const hasUserId = Boolean(item.userId?.S);
  if (!armed) return hasUserId ? 'live' : 'deleted';
  return hasUserId ? 'deleting' : 'deleted';
}

/**
 * Read the identity row.
 *
 * `consistent` is the caller's call, and the two callers genuinely differ. The
 * post-write resurrection check MUST be strongly consistent — the auth
 * middleware's gate ran earlier on an eventually-consistent read, which is
 * exactly the window it exists to close. The login pre-check does not: it is a
 * courtesy redirect that fails open, and the middleware backstops it on the very
 * next request.
 */
export async function readIdentityRow(
  sub: string,
  opts: { consistent?: boolean } = {},
): Promise<Record<string, AttributeValue> | undefined> {
  const identity = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `SUB#${sub}` }, sk: { S: 'IDENTITY' } },
      ...(opts.consistent ? { ConsistentRead: true } : {}),
    }),
  );
  return identity.Item;
}

/** {@link classifyIdentityRow} over a strongly-consistent read. */
export async function getIdentityState(userInfo: Pick<UserInfo, 'sub'>): Promise<IdentityState> {
  return classifyIdentityRow(await readIdentityRow(userInfo.sub, { consistent: true }));
}

/**
 * True when the identity behind `userInfo.sub` is gone OR going (FIL-112) —
 * anything but `live`. Both non-live states must answer the same here, which is
 * the point: this is the *post-write* resurrection check, and a writer has to
 * compensate whether the teardown is in flight or already finished.
 *
 * Why it is a reliable post-write verification, not just a pre-check: account
 * deletion arms the SUB# tombstone at confirm time, strictly BEFORE the billing
 * row is purged, and the tombstone is retained forever. So any writer that writes
 * first and then reads this consistently either sees a live identity — in which
 * case the purge had not yet started and will therefore sweep the just-written
 * row — or sees a non-live one and can compensate its own write. Either way a
 * post-teardown resurrection cannot survive.
 *
 * ConsistentRead is mandatory. The auth middleware's tombstone gate ran earlier
 * on an eventually-consistent read, which is exactly the window this call exists
 * to close.
 */
export async function isIdentityTombstoned(userInfo: Pick<UserInfo, 'sub'>): Promise<boolean> {
  return (await getIdentityState(userInfo)) !== 'live';
}
