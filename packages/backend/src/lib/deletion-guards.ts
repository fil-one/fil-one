import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { UpdateItemCommandOutput } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import type { OrgDeletionMember } from './dynamo-records.js';

const dynamo = getDynamoClient();

/**
 * The security-critical deletion fences (FIL-112): guard Stripe billing
 * writes and the grace-period enforcer off the billing record, block tenant
 * setup on the profile, and tombstone every member identity so all sessions
 * die on their very next request.
 *
 * Applied synchronously by the delete-account confirm handler before its 200,
 * and RE-applied idempotently by the teardown worker at the start of every
 * pass: the confirm handler consumes the challenge before writing the fences,
 * so a crash in between leaves a DELETION record with no fences and a burned
 * code — the worker closes that gap.
 */
export async function applyDeletionGuards(
  orgId: string,
  members: OrgDeletionMember[],
): Promise<void> {
  const now = new Date().toISOString();

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: `ORG#${orgId}`, sk: 'PROFILE' }),
        UpdateExpression: 'SET deleting = :true',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: marshall({ ':true': true }),
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // Profile already purged by a running teardown — nothing to guard.
  }

  // Per-member guards are independent — apply them all in parallel.
  await Promise.all(members.map((member) => guardMember(member, now)));
}

/**
 * Clear the org-profile `deleting` guard — the supported unwedge (FIL-112), driven by
 * the deletion orchestrator when it finds `deleting = true` on an org with NO
 * DELETION record at all. Until this existed, `deleting = true` was written
 * here and cleared nowhere, so such an org could never create an access key or
 * a RAG key, toggle RAG on a bucket, or have a tenant provisioned again.
 *
 * **It covers only the record-less case, deliberately.** The commoner wedge —
 * a teardown that failed and left a non-DONE DELETION record — is NOT unwedged
 * by anything: from the outside that is indistinguishable from a teardown still
 * in flight, and un-fencing a live deletion is the far more expensive mistake.
 * The escape hatch there is manual: an operator deletes the `ORG#{orgId}` /
 * `DELETION` row, after which the next orchestrator run clears the guard.
 *
 * **REMOVE, never `SET deleting = false`.** The read-side fence
 * (`orgNotDeletingCheck`) accepts a literal `false`, but three tenant-setup
 * writers condition their tenant-id write on `attribute_not_exists(deleting)`
 * (lib/orchestrator/tenant-setup.ts, lib/fth/fth-tenant-setup.ts,
 * lib/aurora/aurora-tenant-setup.ts). A `false` would therefore un-fence the
 * shared check while leaving tenant setup refused forever.
 *
 * **One transaction, because `deleting = true` is not a race-detector.** A
 * check-then-write — read the DELETION record, then clear conditional on
 * `deleting = :true` — does not close the window: if a teardown starts in
 * between it sets `deleting = true` on an org that was ALREADY fenced, so the
 * value never changes and that condition still holds. The clear would succeed
 * against a live deletion. What actually has to hold is "no DELETION record
 * exists", so it is asserted atomically alongside the write: a `ConditionCheck`
 * on `ORG#{orgId}` / `DELETION` for `attribute_not_exists(pk)`, paired with the
 * `Update` on `ORG#{orgId}` / `PROFILE` — same table, same partition. This also
 * makes a separate strongly-consistent read redundant: the transaction IS the
 * consistent read.
 *
 * @returns true when this call cleared the fence; false when a DELETION record
 *   exists, the profile is gone, or `deleting` was no longer `true`.
 */
export async function clearOrgDeletionGuard(orgId: string): Promise<boolean> {
  try {
    await dynamo.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: Resource.UserInfoTable.name,
              Key: marshall({ pk: `ORG#${orgId}`, sk: 'DELETION' }),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: Resource.UserInfoTable.name,
              Key: marshall({ pk: `ORG#${orgId}`, sk: 'PROFILE' }),
              UpdateExpression: 'REMOVE deleting',
              ConditionExpression: 'attribute_exists(pk) AND deleting = :true',
              ExpressionAttributeValues: marshall({ ':true': true }),
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (!isConditionCancellation(err)) throw err;
    return false;
  }
}

/**
 * A transaction reports a failed condition as a CANCELLATION, and cancels for
 * other reasons too — `TransactionConflict`, throttling, capacity. Only a
 * `ConditionalCheckFailed` reason means "the org is not eligible for an
 * unwedge"; the rest are transient and must propagate so the orchestrator logs
 * them and the next run retries, rather than being silently read as "declined".
 */
function isConditionCancellation(err: unknown): boolean {
  if (!(err instanceof TransactionCanceledException)) return false;
  const reasons = err.CancellationReasons ?? [];
  return reasons.some((reason) => reason.Code === 'ConditionalCheckFailed');
}

/** Billing-webhook deletion guard + SUB# session kill for one member, in parallel. */
async function guardMember(member: OrgDeletionMember, now: string): Promise<void> {
  const billingGuard = (async () => {
    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: Resource.BillingTable.name,
          Key: marshall({ pk: `CUSTOMER#${member.userId}`, sk: 'SUBSCRIPTION' }),
          UpdateExpression: 'SET deletionRequestedAt = :now',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: marshall({ ':now': now }),
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      // No billing record (e.g. trial never started) — nothing to guard.
    }
  })();

  // if_not_exists keeps the original deletion timestamp stable across
  // idempotent re-confirms (and matches the worker's purge step).
  const sessionKill = member.sub
    ? dynamo.send(
        new UpdateItemCommand({
          TableName: Resource.UserInfoTable.name,
          Key: marshall({ pk: `SUB#${member.sub}`, sk: 'IDENTITY' }),
          UpdateExpression: 'SET deleted = :true, deletedAt = if_not_exists(deletedAt, :now)',
          ExpressionAttributeValues: marshall({ ':true': true, ':now': now }),
        }),
      )
    : Promise.resolve();

  await Promise.all([billingGuard, sessionKill]);
}

// ---------------------------------------------------------------------------
// The billing guard (the DynamoDB condition half)
// ---------------------------------------------------------------------------

/**
 * The billing guard: the condition every write to a customer's billing record
 * carries, so our own teardown-driven `subscriptions.cancel` cannot echo back as
 * a webhook event that upserts a zombie record or re-activates a disabled tenant.
 *
 * It covers BillingTable `CUSTOMER#{userId}/SUBSCRIPTION` writes and nothing
 * else, and that narrowness is structural rather than an oversight: an attribute
 * on a row cannot fence the write that CREATES the row — there is no row yet to
 * carry it. Record-creating billing writers are therefore held off by the
 * identity tombstone, and non-BillingTable surfaces (access keys, RAG keys,
 * bucket rows) by the org-profile `deleting` guard.
 *
 * `deletionRequestedAt` is armed by the account teardown when it claims the
 * record. Until it is armed the condition reduces to `attribute_exists(pk)`,
 * which is the half that blocks upsert-driven resurrection of purged records.
 *
 */
export const DELETION_GUARD = 'attribute_exists(pk) AND attribute_not_exists(deletionRequestedAt)';

/**
 * Returns null when the guard rejects the write (record purged or org
 * mid-deletion) — callers must then skip follow-on tenant status syncs.
 */
export async function sendGuardedBillingUpdate(
  input: Omit<ConstructorParameters<typeof UpdateItemCommand>[0], 'ConditionExpression'>,
): Promise<UpdateItemCommandOutput | null> {
  try {
    return await dynamo.send(
      new UpdateItemCommand({ ...input, ConditionExpression: DELETION_GUARD }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Both the `source` context and the rejection metric are gone, so the key
      // and the expression are all that identify which writer was refused.
      console.warn('[deletion-guard] Billing record missing or org mid-deletion; skipping update', {
        key: input.Key,
        updateExpression: input.UpdateExpression,
      });
      return null;
    }
    throw err;
  }
}
