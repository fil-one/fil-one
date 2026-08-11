import {
  GetItemCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import pRetry, { type Options as RetryOptions } from 'p-retry';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';

const dynamo = getDynamoClient();

/** The raw `ORG#{orgId}/PROFILE` item from UserInfoTable. */
export type OrgProfileItem = Record<string, AttributeValue>;

export interface GetOrgProfileOptions {
  /**
   * Issue a strongly-consistent read. **Required** for callers that gate on a
   * *fail-open* attribute — above all the `deleting` fence (FIL-112), where a
   * stale read means provisioning against, or handing credentials to, an org
   * whose teardown has already started — and for teardown's own tenant-id
   * resolution, where a stale read leaks the tenant instead. See the
   * read-semantics note below for why mutability alone is not the test.
   */
  consistent?: boolean;
}

// Fetches the `ORG#{orgId}/PROFILE` row shared by all orchestrators, so
// callers consulting several orchestrators read the row once instead of once
// per orchestrator.
//
// Read semantics. The question is not "is the attribute mutable?" but "which
// way does a stale read fail?":
//
// - **Monotone in the safe direction → eventually consistent is fine.** The
//   tenant ids (auroraTenantId, fthTenantId) are write-once, and the setup
//   statuses (auroraSetupStatus, fthSetupStatus) only ever advance toward
//   complete. A stale read can therefore only *under*-report readiness — the
//   caller concludes "not provisioned yet" and re-drives setup, which is
//   idempotent. It can never report a tenant that is not there, nor a wrong
//   tenant id. `auroraSetupStatus` is mutable and is read this way from every
//   `isTenantReady` call site; that is correct, not a gap to be closed.
//   Teardown is the exception, because the safe direction is reversed there:
//   "not provisioned yet" means "skip this region", and the profile it was
//   read from is deleted moments later, so the tenant id is unrecoverable.
//   `getRegionsWithTenantIdsForOrg` and the teardown's own region resolution
//   therefore read consistently (FIL-112).
// - **Fail-open → strongly consistent is required.** `deleting` is *absent*
//   until the teardown starts, so a stale read answers "not deleting" for an
//   org that is already being torn down, and the caller proceeds. There is no
//   safe direction to be stale in. Callers gating on `deleting` must pass
//   `{ consistent: true }`; the tenant-setup flows all do.
// - No ProjectionExpression: it would not reduce consumed RCUs, and different
//   orchestrators need different attributes from the same row.
export async function getOrgProfile(
  orgId: string,
  options: GetOrgProfileOptions = {},
): Promise<OrgProfileItem | undefined> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
      // Spread so the eventually-consistent call site sends no ConsistentRead
      // key at all, matching DynamoDB's default.
      ...(options.consistent ? { ConsistentRead: true } : {}),
    }),
  );
  return Item;
}

/**
 * The org-profile `deleting` predicate (FIL-112), in one place so every reader agrees on what
 * "deleting" means. Only ever call this on a profile fetched with
 * `{ consistent: true }` — see the read-semantics note above.
 *
 * A *missing* profile reads as "not deleting" here; the write-side fence
 * ({@link orgNotDeletingCheck}) deliberately does NOT, because the two answer
 * different questions — see its doc comment.
 */
export function isOrgDeleting(orgProfile: OrgProfileItem | undefined): boolean {
  return orgProfile?.deleting?.BOOL === true;
}

/**
 * Account deletion in progress (FIL-112): never provision against an org
 * being torn down — a tenant setup racing the teardown would orphan a live
 * tenant. Every orchestrator's tenant-setup path must call this right after
 * its `getOrgProfile(orgId, { consistent: true })`.
 */
export function assertOrgNotDeleting(orgProfile: OrgProfileItem | undefined, orgId: string): void {
  if (isOrgDeleting(orgProfile)) {
    throw new Error(`Org ${orgId} is being deleted; refusing tenant setup`);
  }
}

/** Raised by {@link sendDeletionGuardedWrite} when the org-profile `deleting` guard rejected the write. */
export class OrgDeletingError extends Error {
  readonly orgId: string;

  constructor(orgId: string) {
    super(`Org ${orgId} is being deleted; refusing write`);
    this.name = 'OrgDeletingError';
    this.orgId = orgId;
  }
}

/**
 * The org-profile `deleting` guard expressed as a transaction pre-condition. It lives on a *different
 * item* than anything its callers write (`ORG#{orgId}/PROFILE`), and a
 * DynamoDB `ConditionExpression` can only ever evaluate against the item being
 * written — so no caller, however simple, can express this as its own
 * condition. That, not the shape of the caller's write, is why a transaction is
 * needed: the biggest caller (`handlers/create-access-key.ts`) is a
 * single-item, same-table Put.
 *
 * **The predicate mirrors {@link isOrgDeleting} — plus item existence.** The
 * profile must exist AND must not be flagged:
 *
 * - `attribute_exists(pk)` — DynamoDB evaluates `attribute_not_exists(deleting)`
 *   against a *missing* item as TRUE, so without this the fence passes once
 *   `purgeRecords` has deleted the PROFILE row and every fenced writer could
 *   resurrect a purged account. Requiring the row is safe: `ORG#/PROFILE` is
 *   created by `createNewUserAndOrg` (middleware/auth.ts) inside the SAME
 *   `TransactWriteItems` as the `SUB#/IDENTITY` row that is the only path to
 *   the `orgId`, so there is no window in which a live org can be missing it,
 *   and the only deleter is the teardown's `purgeRecords`. A missing profile
 *   therefore means purged — refusing is the intent, not an outage.
 * - `OR deleting = :notDeleting` — `isOrgDeleting` tests `deleting === true`,
 *   so a literal `deleting: false` (what a hand-rolled ops edit would write)
 *   reads as healthy. Without this half the fence would disagree with every
 *   reader; for `create-access-key` that combination is the worst one, since
 *   its pre-check would pass, the credential would be minted upstream, and the
 *   compensating revoke would then destroy a healthy org's key.
 *
 * The supported unwedge (FIL-112) is `clearOrgDeletionGuard` in
 * lib/deletion-guards.ts, driven by the deletion orchestrator. It **REMOVEs**
 * the attribute rather than setting it to `false`, because
 * `lib/orchestrator/tenant-setup.ts`, `lib/fth/fth-tenant-setup.ts` and
 * `lib/aurora/aurora-tenant-setup.ts` condition their tenant-id write on
 * `attribute_not_exists(deleting)` — a literal `false` would satisfy this
 * check while leaving tenant setup refused forever.
 */
export function orgNotDeletingCheck(orgId: string): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
      ConditionExpression:
        'attribute_exists(pk) AND (attribute_not_exists(deleting) OR deleting = :notDeleting)',
      ExpressionAttributeValues: { ':notDeleting': { BOOL: false } },
    },
  };
}

/**
 * A `ConditionCheck` participates fully in the transaction, so a concurrent
 * write to `ORG#{orgId}/PROFILE` — tenant setup persisting a tenant id, the
 * deletion guards arming the flag, update-profile renaming the org — cancels
 * the WHOLE transaction with `TransactionConflict`, a failure class that did
 * not exist for these writers when they were plain `PutItem`s. It is transient
 * by definition (the loser of an optimistic race), and every fenced write is
 * idempotent, so retry it a couple of times rather than surfacing a 500 for
 * "someone renamed the org while you created a key". Three attempts at ~50ms
 * is enough for the contended-single-item case and still bounded well inside
 * an API Gateway budget.
 */
const FENCED_WRITE_RETRY: RetryOptions = { retries: 2, minTimeout: 50, randomize: true };

/**
 * Send `writes` in one transaction, gated on the org-profile `deleting` guard. The check is always item
 * 0, so a cancellation is attributable: only `CancellationReasons[0]` being a
 * `ConditionalCheckFailed` means the fence rejected, and that becomes an
 * {@link OrgDeletingError}. A `TransactionConflict` is retried (see
 * {@link FENCED_WRITE_RETRY}); anything else — a caller's own condition,
 * capacity — is re-thrown untouched, unchanged from before the fence existed.
 *
 * The transaction is what makes this a fence rather than a check-then-write:
 * the guarded writes and the fence evaluation commit or fail together, so a
 * teardown arming `deleting` concurrently cannot land between them.
 */
export async function sendDeletionGuardedWrite(
  orgId: string,
  writes: TransactWriteItem[],
  retry: RetryOptions = FENCED_WRITE_RETRY,
): Promise<void> {
  try {
    await pRetry(
      () =>
        getDynamoClient().send(
          new TransactWriteItemsCommand({ TransactItems: [orgNotDeletingCheck(orgId), ...writes] }),
        ),
      { ...retry, shouldRetry: ({ error }) => isTransactionConflict(error) },
    );
  } catch (err) {
    if (isDeletionGuardRejection(err)) throw new OrgDeletingError(orgId);
    throw err;
  }
}

function isDeletionGuardRejection(err: unknown): boolean {
  return (
    err instanceof TransactionCanceledException &&
    err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
  );
}

/**
 * A cancellation caused by contention on one of the transaction's items —
 * overwhelmingly `ORG#{orgId}/PROFILE`, the item the fence adds. Never the
 * fence *rejecting*: that is `ConditionalCheckFailed` on item 0.
 */
function isTransactionConflict(err: unknown): boolean {
  return (
    err instanceof TransactionCanceledException &&
    !isDeletionGuardRejection(err) &&
    (err.CancellationReasons ?? []).some((reason) => reason.Code === 'TransactionConflict')
  );
}
