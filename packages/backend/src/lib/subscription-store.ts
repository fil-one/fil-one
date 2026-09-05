// The BillingTable subscription row, read and written through one module (IAM
// M1, ADR §5).
//
// The row is keyed `ORG#{orgId}/SUBSCRIPTION`. One org, one subscription is an
// invariant rather than a warning log: membership in an org means riding that
// org's billing, so a second member is served by the same row as the first, and
// ownership transfer changes role attributes and nothing here.
//
// The legacy `CUSTOMER#{userId}` rows are dead. Nothing reads or writes them,
// and the rows themselves are deleted in the runbook's dated cleanup step — see
// docs/BillingRekeyRunbook.md. The key builder keeps `legacyPk` because that
// step, its verification, and the scan-time invariant check still have to
// recognize one that is still standing.

import {
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
  type ReturnValue,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import type { SubscriptionRecord } from './dynamo-records.js';

/**
 * BillingTable subscription keys.
 *
 * `ORG#{orgId}` is the same partition the usage reports already live in
 * (`USAGE_REPORT#` items); the shapes coexist under different sort keys.
 */
export const SubscriptionKeys = {
  orgPk: (orgId: string): string => `ORG#${orgId}`,
  orgPkPrefix: (): string => 'ORG#',
  /**
   * The pre-re-key address. Nothing reads or writes it any more; it is here for
   * the cleanup step that deletes those rows and for the scan filters that have
   * to recognize one if it is still standing.
   */
  legacyPk: (userId: string): string => `CUSTOMER#${userId}`,
  legacyPkPrefix: (): string => 'CUSTOMER#',
  sk: (): string => 'SUBSCRIPTION',
  /** `CUSTOMER#{userId}` -> userId. Undefined for the org key or any other shape. */
  parseLegacyPk: (pk: string): string | undefined => {
    const prefix = SubscriptionKeys.legacyPkPrefix();
    const userId = pk.startsWith(prefix) ? pk.slice(prefix.length) : undefined;
    return userId && !userId.includes('#') ? userId : undefined;
  },
  /** Whether a scanned row is keyed to its org. */
  isOrgPk: (pk: string): boolean => pk.startsWith(SubscriptionKeys.orgPkPrefix()),
} as const;

export interface SubscriptionOwner {
  orgId: string;
  /**
   * The member who owns the Stripe customer. No longer part of any key — it is
   * stamped on the row, because the paths that close out a deleted Stripe
   * customer need a user id and the partition key no longer carries one.
   *
   * Optional, because a webhook can name an org and not a user, and stamping
   * `''` on the row would be worse than leaving the attribute alone: every
   * lifecycle job reads it, and an empty string is a user id that matches
   * nothing while looking like an answer.
   */
  userId?: string;
}

interface ReadOptions {
  /**
   * Read consistently. The guard needs it — a trial written moments earlier must
   * not read as absent — and it costs a second RCU.
   */
  consistentRead?: boolean;
  /** Narrow the read the way the caller's `ProjectionExpression` would. */
  projectionExpression?: string;
}

const dynamo = getDynamoClient();

/**
 * The org's subscription row — one point read, on the only key it has.
 *
 * It takes no user id. Which member is asking does not change the answer, and a
 * parameter nothing reads would suggest otherwise; the writers take the owner
 * because they stamp it on the row.
 */
export async function readSubscription(
  orgId: string,
  options: ReadOptions = {},
): Promise<SubscriptionRecord | undefined> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.BillingTable.name,
      Key: { pk: { S: SubscriptionKeys.orgPk(orgId) }, sk: { S: SubscriptionKeys.sk() } },
      ...(options.consistentRead ? { ConsistentRead: true } : {}),
      ...(options.projectionExpression
        ? { ProjectionExpression: options.projectionExpression }
        : {}),
    }),
  );
  return Item ? (unmarshall(Item) as SubscriptionRecord) : undefined;
}

/** The attributes a writer reads to check the row still names the objects its event is about. */
export const BILLING_IDENTITY_PROJECTION = 'stripeCustomerId, subscriptionId';

/**
 * Whether a pre-re-key `CUSTOMER#` row is still standing for this user.
 *
 * Nothing reads those rows any more, so this asks one question only: has the
 * backfill missed this account? The trial claim needs to know before it mints a
 * second Stripe customer for an org that already has one. It disappears with the
 * runbook's dated cleanup step, which is what makes the question meaningless.
 */
export async function legacyRowExists(userId: string): Promise<boolean> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.BillingTable.name,
      Key: { pk: { S: SubscriptionKeys.legacyPk(userId) }, sk: { S: SubscriptionKeys.sk() } },
      ProjectionExpression: 'pk',
      ConsistentRead: true,
    }),
  );
  return Item !== undefined;
}

/** The attributes every row carries about who it belongs to. */
export function ownerAttributes({
  orgId,
  userId,
}: SubscriptionOwner): Record<string, AttributeValue> {
  return { orgId: { S: orgId }, ...(userId ? { userId: { S: userId } } : {}) };
}

export interface SubscriptionUpdate {
  UpdateExpression: string;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  ExpressionAttributeNames?: Record<string, string>;
  ConditionExpression?: string;
  ReturnValues?: ReturnValue;
  /**
   * The caller writes a whole record and may bring it into existence. Such a
   * caller MUST set `orgId` and `userId` in its own expression — see
   * {@link ownerAttributes}. Everything else updates a row that is already there
   * and never creates one.
   */
  createsRow?: boolean;
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
   * fence: `attribute_not_exists(deletedAt)`, ANDed onto the row's condition.
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
  /** `ReturnValues` attributes from the row, for a caller reading the prior status. */
  previous?: Record<string, AttributeValue>;
  /** False only for a caller that tolerates a missing row; everyone else's throws. */
  written: boolean;
  /** The write was refused whole by `guardAgainstScrub` (or the caller's own condition beside it). */
  refused?: boolean;
}

/**
 * Apply one update to the org's row.
 *
 * An update asserts the row exists. Without that a `SET` on a key with no row
 * creates one, and what it creates is whatever attributes this one expression
 * happened to name — a subscription with a status and no customer, or a customer
 * and no status. Before the re-key the legacy row absorbed that; now this key is
 * the only one anyone reads, so a phantom row IS the account's billing state.
 * The writers that legitimately create a record say so with `createsRow`.
 */
export async function updateSubscription(
  owner: SubscriptionOwner,
  update: SubscriptionUpdate,
): Promise<SubscriptionWriteResult> {
  const {
    ConditionExpression: callerCondition,
    ReturnValues,
    createsRow,
    tolerateMissingRow,
    guardAgainstScrub,
    ...expression
  } = update;
  const ConditionExpression = withScrubFence(callerCondition, guardAgainstScrub);

  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.BillingTable.name,
        Key: { pk: { S: SubscriptionKeys.orgPk(owner.orgId) }, sk: { S: SubscriptionKeys.sk() } },
        ...expression,
        ...rowCondition(ConditionExpression, createsRow),
        ...(ReturnValues ? { ReturnValues } : {}),
      }),
    );
    return { previous: result.Attributes, written: true };
  } catch (err) {
    const refusal = scrubRefusal(err, guardAgainstScrub, owner);
    if (refusal) return refusal;
    if (!tolerateMissingRow || !isMissingRow(err, ConditionExpression, createsRow)) throw err;
    return { written: false };
  }
}

/** The caller's condition, ANDed with the scrub fence when one is asked for. */
function withScrubFence(
  callerCondition: string | undefined,
  guardAgainstScrub: SubscriptionUpdate['guardAgainstScrub'],
): string | undefined {
  if (!guardAgainstScrub) return callerCondition;
  return callerCondition
    ? `(${callerCondition}) AND attribute_not_exists(deletedAt)`
    : 'attribute_not_exists(deletedAt)';
}

/**
 * A conditional failure under `guardAgainstScrub` is a warned no-op — the row
 * is scrubbed, or the caller's own skip-condition beside the fence refused,
 * and neither is an error the caller can fix. Undefined re-raises.
 */
function scrubRefusal(
  err: unknown,
  guardAgainstScrub: SubscriptionUpdate['guardAgainstScrub'],
  owner: { orgId?: string; userId?: string },
): SubscriptionWriteResult | undefined {
  if (!guardAgainstScrub || !isConditionalCheckFailure(err)) return undefined;
  console.warn('[subscription-store] skipped a refused billing write', {
    caller: guardAgainstScrub.caller,
    ...owner,
  });
  return { written: false, refused: true };
}

/**
 * The row's condition: its own existence, ANDed with whatever the caller
 * requires of the record. A writer that creates the record asserts neither — it
 * is bringing the record into being.
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
 * because the caller's own condition was not met.
 */
function isMissingRow(
  err: unknown,
  callerCondition: string | undefined,
  creates: boolean | undefined,
): boolean {
  return isConditionalCheckFailure(err) && !creates && !callerCondition;
}

/** A billing write that named no org. */
export class MissingOrgIdError extends Error {
  constructor(userId: string | undefined) {
    super(
      `[subscription-store] A billing write names no orgId (userId=${userId ?? 'unknown'}); ` +
        'the row is keyed by org and there is nothing to write it under',
    );
    this.name = 'MissingOrgIdError';
  }
}

/**
 * Update the row for an org that may not be known.
 *
 * The Stripe webhook is the caller. A customer or subscription created before
 * the metadata carried an `orgId` names no org and cannot be written at all —
 * there is no key to write it under, and inventing one would put a subscription
 * on somebody else's partition. Those rows were enumerated and dispositioned by
 * name before the re-key (docs/BillingRekeyRunbook.md), so reaching this branch
 * means a Stripe object nobody has seen yet.
 *
 * It throws rather than logging and returning. The caller is a webhook handler:
 * a throw becomes a 500, which releases the idempotency claim and lets Stripe
 * retry — so once somebody repairs the object's metadata, the retries converge on
 * their own. Returning success would consume the event, and the status change it
 * carried would be gone with it.
 */
export async function updateSubscriptionByUser(
  { orgId, userId }: { orgId?: string; userId?: string },
  update: SubscriptionUpdate,
): Promise<SubscriptionWriteResult> {
  if (!orgId) throw new MissingOrgIdError(userId);
  return updateSubscription({ orgId, ...(userId ? { userId } : {}) }, update);
}

export interface SubscriptionPut {
  /** The record's attributes, without `pk`/`sk` — this module supplies the key. */
  item: Record<string, AttributeValue>;
  ConditionExpression?: string;
}

/**
 * Create the org's record, where one does not exist yet. The one write that is
 * allowed to bring a row into being without saying `createsRow`: putting a whole
 * record is what it does.
 */
export async function writeSubscription(
  owner: SubscriptionOwner,
  { item, ConditionExpression }: SubscriptionPut,
): Promise<void> {
  await dynamo.send(
    new PutItemCommand({
      TableName: Resource.BillingTable.name,
      Item: {
        ...ownerAttributes(owner),
        ...item,
        pk: { S: SubscriptionKeys.orgPk(owner.orgId) },
        sk: { S: SubscriptionKeys.sk() },
      },
      ...(ConditionExpression ? { ConditionExpression } : {}),
    }),
  );
}

export function isConditionalCheckFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
}

// ---------------------------------------------------------------------------
// What the scan-driven jobs read off a row
// ---------------------------------------------------------------------------

/** The two fields every scanning job needs off a subscription row. */
export interface ScannedSubscription {
  pk: string;
  orgId: string;
  /** The member who owns the Stripe customer, from the row's own attribute. */
  userId?: string;
  /** Read here so a same-kind collision can name what each row would bill. */
  subscriptionId?: string;
}

/**
 * Who a scanned row belongs to, or undefined when it cannot say.
 *
 * Both facts are read from the row: `orgId` has been written on every row since
 * the webhook started backfilling it, and `userId` since the re-key. Neither is
 * parsed out of the partition key — a job that did that would read an org id and
 * call it a user the moment it met an org row, which is now every row.
 */
export function scannedSubscription(
  record: Record<string, unknown>,
): ScannedSubscription | undefined {
  const pk = typeof record.pk === 'string' ? record.pk : undefined;
  const orgId = typeof record.orgId === 'string' && record.orgId ? record.orgId : undefined;
  if (!pk || !orgId) return undefined;

  const userId = typeof record.userId === 'string' && record.userId ? record.userId : undefined;
  const subscriptionId =
    typeof record.subscriptionId === 'string' && record.subscriptionId
      ? record.subscriptionId
      : undefined;
  return {
    pk,
    orgId,
    ...(userId ? { userId } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
  };
}

/**
 * Assert one row per org, and say so loudly when it does not hold.
 *
 * One org, one subscription is the invariant the re-key bought. Two rows for one
 * org is one of two different things, and they do not deserve the same alarm:
 *
 * - An `ORG#` row beside a `CUSTOMER#` row of the same org is the expected state
 *   between the flip and the dated cleanup step. Nothing writes the legacy row
 *   any more, so it is a frozen leftover — logged at WARN, naming it as one.
 *   That branch is a backstop for a direct caller: `scanSubscriptions` drops
 *   non-org rows in `scannableOwner`, so a job run reports its leftovers as
 *   `Not an org row, skipping` and never reaches this line. The check stays
 *   because this function is exported, and a caller handing it unfiltered rows
 *   would otherwise silently drop one of them.
 * - Two rows of the SAME kind is the real violation: two live subscriptions for
 *   one org, which the backfill's collision resolution was supposed to have
 *   settled. Logged at ERROR with both `subscriptionId`s, because which of them
 *   Stripe is billing is the first thing anyone will ask.
 *
 * Which row survives is not left to scan order. An `ORG#` row wins over a
 * `CUSTOMER#` row of the same org, because it is the row every read finds and
 * the only one a writer can address: keeping the legacy one would meter its
 * `subscriptionId` to Stripe from the usage orchestrator, and bill the org on a
 * subscription nothing else in the system can see. Between two rows of the same
 * kind there is nothing to choose, so the first stands.
 *
 * The cleanup step's precondition is written against this: zero same-kind ERROR
 * lines across a full run of all three jobs. Leftover WARNs are expected and do
 * not block it (docs/BillingRekeyRunbook.md).
 */
export function assertOneRowPerOrg<T extends ScannedSubscription>(
  rows: readonly T[],
  job: string,
): T[] {
  const byOrg = new Map<string, T>();

  for (const row of rows) {
    const held = byOrg.get(row.orgId);
    if (!held) {
      byOrg.set(row.orgId, row);
      continue;
    }

    const [survivor, extra] = preferOrgKeyed(held, row);
    byOrg.set(row.orgId, survivor);
    reportExtraRow(job, survivor, extra);
  }

  return [...byOrg.values()];
}

function reportExtraRow<T extends ScannedSubscription>(job: string, survivor: T, extra: T): void {
  const detail = {
    orgId: survivor.orgId,
    processing: survivor.pk,
    ignored: extra.pk,
  };

  if (SubscriptionKeys.isOrgPk(survivor.pk) !== SubscriptionKeys.isOrgPk(extra.pk)) {
    console.warn(`[${job}] Leftover CUSTOMER# row beside its org row`, {
      ...detail,
      hint: 'expected between the flip and the dated cleanup step; nothing writes it any more',
    });
    return;
  }

  console.error(`[${job}] INVARIANT VIOLATED: two subscription rows for one org`, {
    ...detail,
    processingSubscriptionId: survivor.subscriptionId ?? '(none)',
    ignoredSubscriptionId: extra.subscriptionId ?? '(none)',
    hint: 'two live subscriptions for one org — check which one Stripe is billing',
  });
}

/**
 * The org-keyed row first, or the incumbent when neither or both are org-keyed:
 * between two rows of the same kind there is nothing to choose.
 */
function preferOrgKeyed<T extends ScannedSubscription>(held: T, next: T): [T, T] {
  if (!SubscriptionKeys.isOrgPk(held.pk) && SubscriptionKeys.isOrgPk(next.pk)) return [next, held];
  return [held, next];
}

export interface SubscriptionScanOptions<T extends ScannedSubscription> {
  /** Log prefix — the job's own name. */
  job: string;
  filterExpression: string;
  expressionAttributeValues: Record<string, AttributeValue>;
  /**
   * Stop after this many candidates instead of reading to the end of the table,
   * for a job that reconciles a slice per run rather than the whole population.
   *
   * A page is kept whole, so the count can overshoot before the loop rechecks
   * it; the return is sliced to honour the cap. Ask for one more than the batch
   * you intend to process and a full return tells you rows were left behind.
   */
  limit?: number;
  /** Row to candidate, or undefined for a row this job has its own reason to skip. */
  select: (record: Record<string, unknown>, owner: ScannedSubscription) => T | undefined;
}

/**
 * The scan every SUBSCRIPTION-status job runs: page the table, read the owner
 * off each row, keep one row per org.
 *
 * NON-ORG ROWS ARE EXCLUDED HERE, not later. Between the flip and the cleanup
 * step the `CUSTOMER#` rows are still standing and still carry whatever status
 * they were frozen at, so a job that scanned them would act on state nothing has
 * updated since: the grace-period enforcer would disable a paying tenant whose
 * legacy row still says `grace_period`, and the usage orchestrator would meter
 * usage to a superseded `subscriptionId`. Dropping them at the scan means a
 * legacy row arriving ALONE for an org — the cohort the backfill missed — is
 * skipped rather than acted on, which is the safe half of that trade.
 */
/** The owner of a row this job may act on, or undefined with the reason logged. */
function scannableOwner(
  record: Record<string, unknown>,
  job: string,
): ScannedSubscription | undefined {
  const owner = scannedSubscription(record);
  if (!owner) {
    console.warn(`[${job}] Missing orgId, skipping`, { pk: record.pk });
    return undefined;
  }
  if (!SubscriptionKeys.isOrgPk(owner.pk)) {
    console.warn(`[${job}] Not an org row, skipping`, {
      pk: owner.pk,
      orgId: owner.orgId,
      hint: 'a CUSTOMER# row the dated cleanup step has not removed yet',
    });
    return undefined;
  }
  if (!owner.userId) {
    // Every writer stamps it and the backfill copied it, so a row without one
    // predates both — and the close-out paths need it now that the key does not
    // carry it.
    console.warn(`[${job}] Subscription row with no userId`, { pk: owner.pk });
  }
  return owner;
}

export async function scanSubscriptions<T extends ScannedSubscription>({
  job,
  filterExpression,
  expressionAttributeValues,
  limit,
  select,
}: SubscriptionScanOptions<T>): Promise<T[]> {
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
      const owner = scannableOwner(record, job);
      if (!owner) continue;
      const candidate = select(record, owner);
      if (candidate) selected.push(candidate);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey && (limit === undefined || selected.length < limit));

  // Sliced after the de-dupe, and after the loop: a page is kept whole, so
  // `selected` can pass `limit` before the condition is next evaluated. A
  // caller that named no cap is handed the array itself, not a copy of it.
  const rows = assertOneRowPerOrg(selected, job);
  return limit === undefined ? rows : rows.slice(0, limit);
}
