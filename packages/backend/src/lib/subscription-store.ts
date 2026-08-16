// The BillingTable subscription row, read and written through one module while
// it moves from the user to the organization (IAM M1, ADR §5).
//
// The row is keyed `CUSTOMER#{userId}/SUBSCRIPTION` today and
// `ORG#{orgId}/SUBSCRIPTION` afterwards. A copy-then-flip is not safe: Stripe
// webhooks mutate these rows continuously, so a twin copied today is stale
// tomorrow. This module is phase 1 of the four-phase transition — every read
// prefers the org key and falls back to the legacy one, and every write lands
// on both keys — so the backfill (phase 2) has a moving target it can catch up
// with, and the flip (phase 3) deletes code rather than data.
//
// TWO RULES HOLD THE PHASE TOGETHER.
//
// 1. A read prefers the org row, so the org row must never be stale and must
//    never be partial. An update therefore only touches an org row that
//    already exists; the row is created by the backfill, or by a writer that
//    writes a whole record and says so with `createsOrgRow`. A partial org
//    twin would shadow a complete legacy row and report a subscription with no
//    status — an account locked out by its own migration.
//
// 2. The legacy write keeps today's exact command, condition, and errors. Its
//    key stays `CUSTOMER#{userId}`, which is the org's only member for as long
//    as this phase lasts: the ADR sequences the whole billing chain ahead of
//    invitations, so no org has a second member who could mint a second legacy
//    row.
//
// A writer that creates the org row also stamps `orgId` and `userId` on it.
// Both are free on the legacy key — one is a scan-time attribute, the other is
// in the partition key — and every lifecycle job needs them once the pk stops
// carrying a user id.

import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
  type ReturnValue,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import type { SubscriptionRecord } from './dynamo-records.js';

/**
 * BillingTable subscription keys, both eras.
 *
 * `ORG#{orgId}` is the same partition the usage reports already live in
 * (`USAGE_REPORT#` items); the shapes coexist under different sort keys.
 */
export const SubscriptionKeys = {
  orgPk: (orgId: string): string => `ORG#${orgId}`,
  orgPkPrefix: (): string => 'ORG#',
  legacyPk: (userId: string): string => `CUSTOMER#${userId}`,
  legacyPkPrefix: (): string => 'CUSTOMER#',
  sk: (): string => 'SUBSCRIPTION',
  /** `CUSTOMER#{userId}` -> userId. Undefined for the org key or any other shape. */
  parseLegacyPk: (pk: string): string | undefined => {
    const prefix = SubscriptionKeys.legacyPkPrefix();
    const userId = pk.startsWith(prefix) ? pk.slice(prefix.length) : undefined;
    return userId && !userId.includes('#') ? userId : undefined;
  },
  /** Whether a scanned row is already keyed to its org. */
  isOrgPk: (pk: string): boolean => pk.startsWith(SubscriptionKeys.orgPkPrefix()),
} as const;

/** Which key a row was read from — the fact a caller needs when it writes back. */
export type SubscriptionKeyKind = 'org' | 'legacy';

export interface StoredSubscription {
  record: SubscriptionRecord;
  /** `legacy` means the org twin does not exist yet, so the backfill has not reached this account. */
  key: SubscriptionKeyKind;
}

export interface SubscriptionOwner {
  orgId: string;
  userId: string;
}

interface ReadOptions {
  /**
   * Read both keys consistently. The guard needs it — a trial written moments
   * earlier must not read as absent — and it costs a second RCU per key.
   */
  consistentRead?: boolean;
  /** Narrow the read the way the caller's `ProjectionExpression` would. */
  projectionExpression?: string;
}

const dynamo = getDynamoClient();

/**
 * The org's subscription row: the org key first, the caller's legacy key as a
 * fallback.
 *
 * Two point reads in the worst case, one once the backfill has run. The
 * fallback is what lets a member of an org whose row has not moved yet keep
 * working, and it is the only line phase 3 has to delete.
 */
export async function readSubscription(
  orgId: string,
  userId: string,
  options: ReadOptions = {},
): Promise<StoredSubscription | undefined> {
  const orgRow = await getRow(SubscriptionKeys.orgPk(orgId), options);
  if (orgRow) return { record: orgRow, key: 'org' };

  const legacyRow = await getRow(SubscriptionKeys.legacyPk(userId), options);
  return legacyRow ? { record: legacyRow, key: 'legacy' } : undefined;
}

async function getRow(
  pk: string,
  { consistentRead, projectionExpression }: ReadOptions,
): Promise<SubscriptionRecord | undefined> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.BillingTable.name,
      Key: { pk: { S: pk }, sk: { S: SubscriptionKeys.sk() } },
      ...(consistentRead ? { ConsistentRead: true } : {}),
      ...(projectionExpression ? { ProjectionExpression: projectionExpression } : {}),
    }),
  );
  return Item ? (unmarshall(Item) as SubscriptionRecord) : undefined;
}

/** The attributes every row carries about who it belongs to, on both keys. */
export function ownerAttributes({
  orgId,
  userId,
}: SubscriptionOwner): Record<string, AttributeValue> {
  return { orgId: { S: orgId }, userId: { S: userId } };
}

export interface SubscriptionUpdate {
  UpdateExpression: string;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  ExpressionAttributeNames?: Record<string, string>;
  /**
   * Applied to both keys. The org row's copy is ANDed with its own existence
   * condition, so a write this condition forbids can never reach the row every
   * read prefers — the org row must not be mutated by something the legacy row
   * would have refused.
   */
  ConditionExpression?: string;
  ReturnValues?: ReturnValue;
  /**
   * The caller writes a whole record and may bring the org row into existence.
   * Such a caller MUST set `orgId` and `userId` in its own expression — see
   * {@link ownerAttributes}. Everything else updates an org row that is already
   * there and skips one that is not.
   */
  createsOrgRow?: boolean;
  /**
   * Refuse the write when the account-deletion teardown has scrubbed the row.
   *
   * The profile fence cannot stop Stripe, which holds no session and retries
   * its callbacks for days, so the rows those callbacks write carry their own
   * fence: `attribute_not_exists(deletedAt)`, ANDed onto both keys' conditions.
   * One clause, sound only because the teardown retains the row — a condition
   * on a missing item reads every attribute as absent and would create one.
   *
   * A refused write is a warned no-op rather than an error: the caller has
   * nothing to fix, and a webhook that threw would be retried for days over a
   * row that will never accept the write. `caller` names the webhook in that
   * log line.
   */
  guardAgainstScrub?: { caller: string };
}

export interface SubscriptionWriteResult {
  /**
   * `ReturnValues` attributes from the authoritative row: the org twin when it
   * exists, the legacy row otherwise. A caller reading the prior status must
   * read the row the guard would have read, not the copy.
   */
  previous?: Record<string, AttributeValue>;
  /** False before the backfill has reached this account, when there is no org row to update. */
  orgRowWritten: boolean;
  /** The write was refused whole by `guardAgainstScrub` (or the caller's own condition beside it). */
  refused?: boolean;
}

/**
 * Apply one update to both keys.
 *
 * The org row goes first. A read prefers it, so it must never be the stale
 * half: if this write cannot land there the run stops before the legacy row
 * moves, and the retry finds both rows where it left them. The one failure
 * that is not an error is the org row not existing — that is every account the
 * backfill has not copied yet, and it is silent by design.
 */
export async function updateSubscription(
  owner: SubscriptionOwner,
  update: SubscriptionUpdate,
): Promise<SubscriptionWriteResult> {
  const tableName = Resource.BillingTable.name;
  const {
    ReturnValues,
    createsOrgRow,
    guardAgainstScrub,
    UpdateExpression,
    ExpressionAttributeValues,
    ExpressionAttributeNames,
  } = update;
  const ConditionExpression = withScrubFence(update);
  const shared = {
    TableName: tableName,
    UpdateExpression,
    ...(ExpressionAttributeValues ? { ExpressionAttributeValues } : {}),
    ...(ExpressionAttributeNames ? { ExpressionAttributeNames } : {}),
    ...(ReturnValues ? { ReturnValues } : {}),
  };

  let orgResult;
  try {
    orgResult = await dynamo.send(
      new UpdateItemCommand({
        ...shared,
        Key: { pk: { S: SubscriptionKeys.orgPk(owner.orgId) }, sk: { S: SubscriptionKeys.sk() } },
        ...orgCondition(ConditionExpression, createsOrgRow),
      }),
    );
  } catch (err) {
    if (!isConditionalCheckFailure(err) || createsOrgRow) throw err;
    // No org twin yet, or one this write's own condition refuses. Both mean
    // the same thing here: leave it alone and let the legacy row answer. The
    // first is every account the backfill has not reached, and the second the
    // caller hears about anyway, because the legacy write carries the same
    // condition and fails the same way.
  }

  let legacyResult;
  try {
    legacyResult = await dynamo.send(
      new UpdateItemCommand({
        ...shared,
        Key: { pk: { S: SubscriptionKeys.legacyPk(owner.userId) }, sk: { S: SubscriptionKeys.sk() } },
        ...(ConditionExpression ? { ConditionExpression } : {}),
      }),
    );
  } catch (err) {
    const refusal = scrubRefusal(err, update, owner);
    if (!refusal) throw err;
    return refusal;
  }

  return {
    previous: orgResult?.Attributes ?? legacyResult.Attributes,
    orgRowWritten: orgResult !== undefined,
  };
}

/** The caller's condition, ANDed with the scrub fence when one is asked for. */
function withScrubFence({
  ConditionExpression,
  guardAgainstScrub,
}: SubscriptionUpdate): string | undefined {
  if (!guardAgainstScrub) return ConditionExpression;
  return ConditionExpression
    ? `(${ConditionExpression}) AND attribute_not_exists(deletedAt)`
    : 'attribute_not_exists(deletedAt)';
}

/**
 * A conditional failure under `guardAgainstScrub` is a warned no-op — the row
 * is scrubbed, or the caller's own skip-condition beside the fence refused,
 * and neither is an error the caller can fix. Undefined re-raises.
 */
function scrubRefusal(
  err: unknown,
  { guardAgainstScrub }: SubscriptionUpdate,
  owner: { orgId?: string; userId?: string },
): SubscriptionWriteResult | undefined {
  if (!guardAgainstScrub || !isConditionalCheckFailure(err)) return undefined;
  console.warn('[subscription-store] skipped a refused billing write', {
    caller: guardAgainstScrub.caller,
    ...owner,
  });
  return { orgRowWritten: false, refused: true };
}

/**
 * Update whichever keys the caller can name.
 *
 * Both, and it is {@link updateSubscription}. Only one, and this is the phase's
 * honest answer for the two callers that may hold one id and not the other: a
 * Stripe object created before the metadata carried an `orgId` names no org
 * (the cohort every lifecycle job already skips, left for the backfill's manual
 * disposition list rather than given an org we invented), and a scanned org row
 * predating this module's `userId` attribute names no user.
 */
export async function updateSubscriptionByUser(
  { orgId, userId }: { orgId?: string; userId?: string },
  update: SubscriptionUpdate,
): Promise<SubscriptionWriteResult> {
  if (orgId && userId) return updateSubscription({ orgId, userId }, update);

  const pk = orgId ? SubscriptionKeys.orgPk(orgId) : userId && SubscriptionKeys.legacyPk(userId);
  if (!pk) throw new Error('A subscription update names neither an org nor a user');

  const { ReturnValues, ...expression } = update;
  const ConditionExpression = withScrubFence(update);
  let result;
  try {
    result = await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.BillingTable.name,
        Key: { pk: { S: pk }, sk: { S: SubscriptionKeys.sk() } },
        UpdateExpression: expression.UpdateExpression,
        ...(expression.ExpressionAttributeValues
          ? { ExpressionAttributeValues: expression.ExpressionAttributeValues }
          : {}),
        ...(expression.ExpressionAttributeNames
          ? { ExpressionAttributeNames: expression.ExpressionAttributeNames }
          : {}),
        ...(ConditionExpression ? { ConditionExpression } : {}),
        ...(ReturnValues ? { ReturnValues } : {}),
      }),
    );
  } catch (err) {
    const refusal = scrubRefusal(err, update, { orgId, userId });
    if (!refusal) throw err;
    return refusal;
  }
  return { previous: result.Attributes, orgRowWritten: Boolean(orgId) };
}

/**
 * The org row's condition: its own existence, ANDed with whatever the caller
 * requires of the record. A writer that creates the row asserts neither — it is
 * bringing the record into being.
 */
function orgCondition(
  callerCondition: string | undefined,
  createsOrgRow: boolean | undefined,
): { ConditionExpression?: string } {
  if (createsOrgRow) return callerCondition ? { ConditionExpression: callerCondition } : {};
  return {
    ConditionExpression: callerCondition
      ? `attribute_exists(pk) AND (${callerCondition})`
      : 'attribute_exists(pk)',
  };
}

export interface SubscriptionPut {
  /** The record's attributes, without `pk`/`sk` — this module supplies both keys. */
  item: Record<string, AttributeValue>;
  ConditionExpression?: string;
}

/**
 * Create the record on both keys.
 *
 * Used where a record does not exist yet, so both keys are born together and
 * the org row is whole from its first write. A condition is applied to each key
 * independently: the legacy row's failure is the caller's to interpret (today's
 * behavior), and the org row's is swallowed, since a row the backfill has
 * already copied is not a reason to fail a request.
 */
export async function writeSubscription(
  owner: SubscriptionOwner,
  { item, ConditionExpression }: SubscriptionPut,
): Promise<void> {
  const tableName = Resource.BillingTable.name;
  const attributes = { ...ownerAttributes(owner), ...item, sk: { S: SubscriptionKeys.sk() } };

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: tableName,
        Item: { ...attributes, pk: { S: SubscriptionKeys.orgPk(owner.orgId) } },
        ...(ConditionExpression ? { ConditionExpression } : {}),
      }),
    );
  } catch (err) {
    if (!isConditionalCheckFailure(err)) throw err;
  }

  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: { ...attributes, pk: { S: SubscriptionKeys.legacyPk(owner.userId) } },
      ...(ConditionExpression ? { ConditionExpression } : {}),
    }),
  );
}

export function isConditionalCheckFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
}

// ---------------------------------------------------------------------------
// What the scan-driven jobs see while both keys exist
// ---------------------------------------------------------------------------

/** The two fields every scanning job needs off a subscription row, whichever key it came from. */
export interface ScannedSubscription {
  pk: string;
  orgId: string;
  /** From the row when it carries one, else from a legacy pk. Absent on an un-backfilled org row. */
  userId?: string;
}

/**
 * Who a scanned row belongs to, or undefined when it cannot say.
 *
 * `orgId` has been written on every row since the webhook started backfilling
 * it, and the jobs already skip the rows that predate it. The user id comes
 * from the row's own attribute first and the legacy key second, so a job keeps
 * working across the re-key without parsing an org id out of a pk and calling
 * it a user.
 */
export function scannedSubscription(
  record: Record<string, unknown>,
): ScannedSubscription | undefined {
  const pk = typeof record.pk === 'string' ? record.pk : undefined;
  const orgId = typeof record.orgId === 'string' && record.orgId ? record.orgId : undefined;
  if (!pk || !orgId) return undefined;

  const userId =
    (typeof record.userId === 'string' && record.userId ? record.userId : undefined) ??
    SubscriptionKeys.parseLegacyPk(pk);
  return { pk, orgId, ...(userId ? { userId } : {}) };
}

/**
 * Drop each legacy row whose org twin is in the same scan.
 *
 * Dual-writing means most accounts appear twice for the length of this phase,
 * and a job that acted on both would disable a tenant twice and count one org
 * as two. The org row wins because it is the one every read prefers.
 */
export function preferOrgRows<T extends ScannedSubscription>(rows: readonly T[]): T[] {
  const orgIdsWithOrgRow = new Set(
    rows.filter((row) => SubscriptionKeys.isOrgPk(row.pk)).map((row) => row.orgId),
  );
  return rows.filter((row) => SubscriptionKeys.isOrgPk(row.pk) || !orgIdsWithOrgRow.has(row.orgId));
}
