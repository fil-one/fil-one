import { ConditionalCheckFailedException, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { invokeAccountDeletionWorker } from './account-deletion-invoke.js';
import { getDynamoClient } from './ddb-client.js';
import { applyDeletionGuards } from './deletion-guards.js';
import { snapshotMembers } from './deletion-snapshot.js';
import {
  DeletionKeys,
  OrgDeletionStatus,
  type OrgDeletionReason,
  type OrgDeletionRecord,
} from './dynamo-records.js';
import { getRegionsWithTenantIdsForOrg } from './region-helpers.js';
import { settleAll } from './settle-all.js';

const dynamo = getDynamoClient();

/**
 * Begin (or idempotently resume) an org teardown (FIL-112): snapshot everything
 * the worker needs onto the DELETION record, then — independently, neither
 * gating the other — fence the org against further billing/session activity and
 * Event-invoke the worker. Callers own their own authorization — this function
 * does none.
 *
 * Deliberately free of the orchestrator registry and vendor clients that
 * `account-deletion.ts` pulls in, so request-time handlers can call it.
 */
export async function startAccountDeletion(
  orgId: string,
  opts: { requestedByUserId: string; reason: OrgDeletionReason },
): Promise<void> {
  // Members only: the Stripe customer is deliberately NOT snapshotted here.
  // A confirm-time snapshot is blind to a customer minted inside the deletion
  // race windows, so teardown discovers it live from Stripe metadata instead
  // (lib/billing-customer-discovery.ts) — over exactly these members.
  const members = await snapshotMembers(orgId);

  // Raw resolution, not readiness-gated: a tenant whose setup is still
  // mid-flight must be torn down too, so the snapshot has to see it.
  const tenantIds = Object.fromEntries(
    (await getRegionsWithTenantIdsForOrg(orgId)).map(({ orchestrator, tenantId }) => [
      orchestrator.id,
      tenantId,
    ]),
  );

  const now = new Date().toISOString();
  const record: OrgDeletionRecord = {
    pk: DeletionKeys.deletionPk(orgId),
    sk: DeletionKeys.deletionSk(),
    status: OrgDeletionStatus.Pending,
    requestedAt: now,
    requestedByUserId: opts.requestedByUserId,
    reason: opts.reason,
    members,
    tenantIds,
    attemptCount: 0,
    updatedAt: now,
  };

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: Resource.UserInfoTable.name,
        Item: marshall(record),
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    // Deletion already started earlier — idempotent re-entry. The guards
    // re-apply harmlessly and the worker invoke resumes the teardown.
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }

  // NEITHER of these may gate the other — that is the whole point of settling
  // them. The challenge is consumed before we get here and the endpoint that
  // issues it refuses to mint a second code while a DELETION record exists, so
  // whichever step is ordered second is the one a failure silently drops:
  // guards-then-invoke leaves the org fenced with nothing scheduled;
  // invoke-then-guards leaves an unfenced org (live sessions, unfenced billing
  // writers, tenant setup still permitted) whose teardown may or may not run.
  // Both are attempted, both failures are reported, and the worker re-applies
  // the same idempotent guards on every pass.
  await settleAll(
    [
      { name: 'invoke', run: () => invokeAccountDeletionWorker(orgId) },
      { name: 'guards', run: () => applyDeletionGuards(orgId, members) },
    ],
    (names) => `Deletion start incomplete for org ${orgId}: ${names}`,
  );
}
