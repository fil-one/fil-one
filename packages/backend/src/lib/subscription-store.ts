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
// 1. An update only ever touches a row that already exists. Every write-shaped
//    call carries `attribute_exists(pk)` on both keys unless its caller says it
//    is creating the record (`createsOrgRow`, or `writeSubscription`, which
//    puts a whole record). A partial org twin would shadow a complete legacy
//    row and report a subscription with no status — an account locked out by
//    its own migration — and a partial legacy row invents a `CUSTOMER#` address
//    for a user who never had one.
//
// 2. A read prefers the org row, so the org row must never be stale. If a write
//    cannot land there for any reason other than the row not existing yet, the
//    run stops before the legacy row moves. "Not existing yet" is every account
//    the backfill has not copied, and it is the one silent failure here.
//
// A writer that creates the org row also stamps `orgId` and `userId` on it.
// Both are free on the legacy key — one is a scan-time attribute, the other is
// in the partition key — and every lifecycle job needs them once the pk stops
// carrying a user id.

import {
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
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
 * Both reads are issued at once. Roughly fifteen gated handlers sit behind this
 * function on every request, and a serial second hop put the fallback's latency
 * on accounts that do not need it. Phase 3 deletes the fallback; until then it
 * costs a parallel RCU rather than a round trip.
 *
 * The fallback is what lets a member of an org whose row has not moved yet keep
 * working — but only for their own org. A legacy row naming a different org is
 * not this org's subscription, and answering with it would let a member of one
 * org spend another org's entitlement once invitations make two orgs reachable
 * by one user. A row with no `orgId` at all predates the attribute and is still
 * served: that cohort is this user's own row by construction.
 */
export async function readSubscription(
  orgId: string,
  userId: string,
  options: ReadOptions = {},
): Promise<StoredSubscription | undefined> {
  const [orgRow, legacyRow] = await Promise.all([
    getRow(SubscriptionKeys.orgPk(orgId), options),
    getRow(SubscriptionKeys.legacyPk(userId), options),
  ]);
  if (orgRow) return { record: orgRow, key: 'org' };
  if (!legacyRow) return undefined;

  if (legacyRow.orgId && legacyRow.orgId !== orgId) {
    console.warn('[subscription-store] Legacy row names another org, not serving it', {
      userId,
      requestedOrgId: orgId,
      rowOrgId: legacyRow.orgId,
    });
    return undefined;
  }
  return { record: legacyRow, key: 'legacy' };
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
   * Applied to both keys. Each key's copy is ANDed with its own existence
   * condition, so a write this condition forbids can never reach the row every
   * read prefers — the org row must not be mutated by something the legacy row
   * would have refused.
   */
  ConditionExpression?: string;
  ReturnValues?: ReturnValue;
  /**
   * The caller writes a whole record and may bring it into existence on either
   * key. Such a caller MUST set `orgId` and `userId` in its own expression — see
   * {@link ownerAttributes}. Everything else updates a row that is already there
   * and never creates one.
   */
  createsOrgRow?: boolean;
  /**
   * A row that is not there is a reported outcome, not an error. For the
   * close-out paths, whose whole job is to cancel whatever is left of an account
   * that may already have been removed. Applies to the bare existence guard
   * only: a caller condition the row fails still throws.
   */
  tolerateMissingRow?: boolean;
  /**
   * Refuse the write when the account-deletion teardown has scrubbed the row.
   *
   * The profile fence cannot stop Stripe, which holds no session and retries
   * its callbacks for days, so the rows those callbacks write carry their own
   * fence: `attribute_not_exists(deletedAt)`, ANDed onto both keys' conditions.
   * One clause, sound only because the teardown retains the row — a condition
   * on a missing item reads every attribute as absent, and it is the
   * `attribute_exists(pk)` this module already applies that keeps the fence
   * from minting a row.
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
  /**
   * False when the legacy row was not there. Only `tolerateMissingRow` gets to
   * see this as false — everyone else's missing legacy row throws.
   */
  legacyRowWritten: boolean;
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
    tolerateMissingRow,
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
        ...rowCondition(ConditionExpression, createsOrgRow),
      }),
    );
  } catch (err) {
    // Only the bare existence guard is silent, and only because "no org twin
    // yet" is every account the backfill has not reached. A caller condition
    // the org row failed is a fact about the record, not about the migration:
    // the legacy row may satisfy the same condition and diverge from the row
    // every read prefers, so it is raised rather than assumed symmetrical.
    // Under `guardAgainstScrub`, every conditional failure on this key defers
    // to the legacy write, whose classification answers for both.
    if (guardAgainstScrub && isConditionalCheckFailure(err)) {
      // The legacy write decides the outcome.
    } else if (!isMissingRow(err, ConditionExpression, createsOrgRow)) {
      throw err;
    }
  }

  let legacyResult;
  try {
    legacyResult = await dynamo.send(
      new UpdateItemCommand({
        ...shared,
        Key: {
          pk: { S: SubscriptionKeys.legacyPk(owner.userId) },
          sk: { S: SubscriptionKeys.sk() },
        },
        ...rowCondition(ConditionExpression, createsOrgRow),
      }),
    );
  } catch (err) {
    const refusal = scrubRefusal(err, update, owner);
    if (refusal) return refusal;
    if (!tolerateMissingRow || !isMissingRow(err, ConditionExpression, createsOrgRow)) throw err;
  }

  return {
    previous: orgResult?.Attributes ?? legacyResult?.Attributes,
    orgRowWritten: orgResult !== undefined,
    legacyRowWritten: legacyResult !== undefined,
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
  return { orgRowWritten: false, legacyRowWritten: false, refused: true };
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

  const { ReturnValues, createsOrgRow, tolerateMissingRow, ...expression } = update;
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
        // The same condition policy as the two-key path. One key is fewer
        // writes, not weaker rules: an unconditional upsert here would mint the
        // partial row rule 1 exists to prevent, on whichever key the caller
        // happened to name.
        ...rowCondition(ConditionExpression, createsOrgRow),
        ...(ReturnValues ? { ReturnValues } : {}),
      }),
    );
  } catch (err) {
    const refusal = scrubRefusal(err, update, { orgId, userId });
    if (refusal) return refusal;
    if (!tolerateMissingRow || !isMissingRow(err, ConditionExpression, createsOrgRow)) throw err;
  }
  const written = result !== undefined;
  return {
    previous: result?.Attributes,
    orgRowWritten: Boolean(orgId) && written,
    legacyRowWritten: !orgId && written,
  };
}

/**
 * A row's condition: its own existence, ANDed with whatever the caller requires
 * of the record. A writer that creates the record asserts neither — it is
 * bringing the record into being.
 */
function rowCondition(
  callerCondition: string | undefined,
  creates: boolean | undefined,
): { ConditionExpression?: string } {
  if (creates) return callerCondition ? { ConditionExpression: callerCondition } : {};
  return {
    ConditionExpression: callerCondition
      ? `attribute_exists(pk) AND (${callerCondition})`
      : 'attribute_exists(pk)',
  };
}

/**
 * Whether a failed write failed because the row is not there, as opposed to
 * because the caller's own condition was not met. Only the first is ever
 * treated as an outcome rather than an error.
 */
function isMissingRow(
  err: unknown,
  callerCondition: string | undefined,
  creates: boolean | undefined,
): boolean {
  return isConditionalCheckFailure(err) && !creates && !callerCondition;
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
 * the org row is whole from its first write.
 *
 * The org PUT is transactional with a check on the legacy key, because a
 * caller's "no record" read can be true of the org key and false of the legacy
 * one: an account the backfill has not copied has a complete legacy row and no
 * twin, and a bare PUT would drop a status-less org row in front of it. Every
 * read prefers the org row, so that row reports a subscription with no status
 * and the account is locked out by its own migration. If the legacy row is
 * there, the transaction is refused and the org key is left for the backfill.
 *
 * The legacy PUT follows with its own condition, and its failure is the
 * caller's to interpret — today's behavior.
 */
export async function writeSubscription(
  owner: SubscriptionOwner,
  { item, ConditionExpression }: SubscriptionPut,
): Promise<void> {
  const tableName = Resource.BillingTable.name;
  const attributes = { ...ownerAttributes(owner), ...item, sk: { S: SubscriptionKeys.sk() } };
  const legacyKey = {
    pk: { S: SubscriptionKeys.legacyPk(owner.userId) },
    sk: { S: SubscriptionKeys.sk() },
  };

  try {
    await dynamo.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: { ...attributes, pk: { S: SubscriptionKeys.orgPk(owner.orgId) } },
              ...(ConditionExpression ? { ConditionExpression } : {}),
            },
          },
          {
            ConditionCheck: {
              TableName: tableName,
              Key: legacyKey,
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
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

/**
 * Whether a write failed its condition. A transaction reports the same thing
 * one level down, in the cancellation reasons, so both shapes answer here — the
 * callers care that the row refused the write, not which command carried it.
 */
export function isConditionalCheckFailure(err: unknown): boolean {
  const error = err as { name?: string; CancellationReasons?: { Code?: string }[] } | null;
  if (error?.name === 'ConditionalCheckFailedException') return true;
  return (
    error?.name === 'TransactionCanceledException' &&
    (error.CancellationReasons ?? []).some((reason) => reason.Code === 'ConditionalCheckFailed')
  );
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

export interface SubscriptionScanOptions<T extends ScannedSubscription> {
  /** Log prefix — the job's own name. */
  job: string;
  filterExpression: string;
  expressionAttributeValues: Record<string, AttributeValue>;
  /** Row to candidate, or undefined for a row this job has its own reason to skip. */
  select: (record: Record<string, unknown>, owner: ScannedSubscription) => T | undefined;
  /**
   * Which of two rows for one org this job would rather act on, once the
   * org/legacy pair has already been resolved. Default: the one scanned first.
   */
  prefer?: (held: T, next: T) => T;
  /** What to print about each side of a collision, beyond its key. */
  describe?: (row: T) => Record<string, unknown>;
}

/**
 * The scan every SUBSCRIPTION-status job runs: page the table, read the owner
 * off each row, keep one row per org.
 *
 * Three jobs used to carry their own copy of this — three paginations, three
 * skip logs, and three different answers to "two rows name one org", one of
 * which was decided by whatever order DynamoDB returned the pages in. One org
 * is one tenant to disable, one usage report, and one drift probe, so which row
 * a job acts on is a correctness question and it is answered here.
 */
export async function scanSubscriptions<T extends ScannedSubscription>(
  options: SubscriptionScanOptions<T>,
): Promise<T[]> {
  const { job, filterExpression, expressionAttributeValues, select } = options;
  const selected: T[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: Resource.BillingTable.name,
        FilterExpression: filterExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );

    for (const item of result.Items ?? []) {
      const record = unmarshall(item);
      const owner = scannedSubscription(record);
      if (!owner) {
        console.warn(`[${job}] Missing orgId, skipping`, { pk: record.pk });
        continue;
      }
      if (!owner.userId) {
        // The backfill stamps `userId` on every row it copies and every writer
        // sets it, so a row without one predates both. The close-out paths need
        // it, and after the flip there is no pk left to recover it from.
        console.warn(`[${job}] Subscription row with no userId`, { pk: owner.pk });
      }
      const candidate = select(record, owner);
      if (candidate) selected.push(candidate);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return dedupeByOrg(preferOrgRows(selected), options);
}

/**
 * One row per org, and a warning for every row that loses.
 *
 * `preferOrgRows` has already resolved the dual-write's twins, so what arrives
 * here is two rows of the same kind for one org — re-subscription history left
 * some orgs with two legacy rows. That is the collision the backfill halts on
 * and a human resolves, so it is named loudly rather than dropped quietly, with
 * whatever each job can say about how the two differ.
 */
function dedupeByOrg<T extends ScannedSubscription>(
  rows: readonly T[],
  { job, prefer, describe }: Pick<SubscriptionScanOptions<T>, 'job' | 'prefer' | 'describe'>,
): T[] {
  const byOrg = new Map<string, T>();

  for (const row of rows) {
    const held = byOrg.get(row.orgId);
    if (!held) {
      byOrg.set(row.orgId, row);
      continue;
    }
    const survivor = prefer ? prefer(held, row) : held;
    const ignored = survivor === held ? row : held;
    byOrg.set(row.orgId, survivor);
    console.warn(`[${job}] Second subscription row for one org, skipped`, {
      orgId: row.orgId,
      processing: survivor.pk,
      skipped: ignored.pk,
      ...(describe
        ? { processingDetail: describe(survivor), skippedDetail: describe(ignored) }
        : {}),
    });
  }

  return [...byOrg.values()];
}
