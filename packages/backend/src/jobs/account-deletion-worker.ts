import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { deleteAuth0User } from '../lib/auth0-management.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { deletionRecordKey, DELETION_STATUS, type DeletionRecord } from '../lib/deletion-record.js';
import { purgeOrgRecords } from '../lib/deletion-purge.js';
import { tearDownStripe } from '../lib/deletion-stripe-teardown.js';
import { NotImplementedError } from '../lib/errors.js';
import { getAvailableOrchestrators } from '../lib/service-orchestrator-registry.js';

const LOG = '[account-deletion-worker]';

export interface AccountDeletionWorkerPayload {
  orgId: string;
}

/**
 * Tears down everything a deleted org owns. Every step is idempotent, so
 * recovery is "run the whole thing again": any throw means two async retries,
 * then the DLQ, and the sweeper re-drives while `status` is PENDING.
 */
export async function handler(event: AccountDeletionWorkerPayload): Promise<void> {
  const { orgId } = event;
  // Swallowing this would mark the invoke successful and never retry.
  if (!orgId) throw new Error(`${LOG} payload has no orgId`);

  const record = await readDeletionRecord(orgId);
  if (!record) throw new Error(`${LOG} no DELETION record for org ${orgId}`);
  if (record.status === DELETION_STATUS.done) {
    console.log(`${LOG} already done, nothing to do`, { orgId });
    return;
  }

  await beginPass(orgId);

  // Do not reorder: the purge destroys the record these steps read from.
  await tearDownStripe(record.members);
  await deleteTenants(orgId, record.tenantIds);
  await purgeOrgRecords(orgId, record);
  await deleteAuth0Users(record.members.map((member) => member.sub));

  await markDone(orgId);
  console.log(`${LOG} teardown complete`, { orgId, attempt: record.attempts + 1 });
}

/** Consistent: a stale read right after confirm misses the record entirely. */
async function readDeletionRecord(orgId: string): Promise<DeletionRecord | undefined> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: deletionRecordKey(orgId),
      ConsistentRead: true,
    }),
  );
  return Item ? (unmarshall(Item) as DeletionRecord) : undefined;
}

/** Before any work, so the sweeper does not re-drive a healthy long purge. */
async function beginPass(orgId: string): Promise<void> {
  await getDynamoClient().send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: deletionRecordKey(orgId),
      UpdateExpression: 'ADD attempts :one SET updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: marshall({ ':one': 1, ':now': new Date().toISOString() }),
    }),
  );
}

/**
 * NotImplementedError is skipped, not fatal: Aurora exposes no tenant DELETE
 * (FIL-919), and failing here would block the purge for every Aurora org. The
 * residual is a live tenant behind a deleted account, logged each pass.
 */
async function deleteTenants(orgId: string, tenantIds: Record<string, string>): Promise<void> {
  for (const [orchestratorId, tenantId] of Object.entries(tenantIds ?? {})) {
    const orchestrator = getAvailableOrchestrators().find((o) => o.id === orchestratorId);
    if (!orchestrator) {
      console.warn(`${LOG} no orchestrator registered, skipping tenant`, {
        orgId,
        orchestratorId,
        tenantId,
      });
      continue;
    }

    try {
      await orchestrator.deleteTenant(tenantId);
      console.log(`${LOG} tenant deleted`, { orgId, orchestratorId, tenantId });
    } catch (err) {
      if (!(err instanceof NotImplementedError)) throw err;
      console.error(`${LOG} provider cannot delete tenants; customer data survives upstream`, {
        orgId,
        orchestratorId,
        tenantId,
      });
    }
  }
}

async function deleteAuth0Users(subs: string[]): Promise<void> {
  for (const sub of subs) {
    await deleteAuth0User(sub);
  }
}

async function markDone(orgId: string): Promise<void> {
  await getDynamoClient().send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: deletionRecordKey(orgId),
      UpdateExpression: 'SET #status = :done, updatedAt = :now',
      // A vanished record is a bug, not an already-done pass.
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':done': DELETION_STATUS.done,
        ':now': new Date().toISOString(),
      }),
    }),
  );
}
