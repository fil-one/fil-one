import { ConditionalCheckFailedException, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
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
import type { AccountDeletionWorkerPayload } from '../jobs/account-deletion-worker.js';

const dynamo = getDynamoClient();
const lambda = new LambdaClient({});

/**
 * Begin (or idempotently resume) an org teardown (FIL-112): snapshot everything
 * the worker needs onto the DELETION record, fence the org against further
 * billing/session activity, then Event-invoke the worker. Callers own their own
 * authorization — this function does none.
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
    // Deletion already started earlier — idempotent re-entry. The guards below
    // re-apply harmlessly and the worker invoke resumes the teardown.
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }

  await applyDeletionGuards(orgId, members);

  const payload: AccountDeletionWorkerPayload = { orgId };
  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.ACCOUNT_DELETION_WORKER_FUNCTION_NAME!,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}
