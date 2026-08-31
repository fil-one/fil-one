import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { deleteAuth0User, getAuth0UserEmail } from '../lib/auth0-management.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import {
  deletionRecordKey,
  DELETION_STATUS,
  type DeletionMember,
  type DeletionRecord,
} from '../lib/deletion-record.js';
import { resolveDeletionTargets } from '../lib/deletion-targets.js';
import { ragAllowlistKey } from '../middleware/rag-access.js';
import { scrubOrgRecords } from '../lib/deletion-scrub.js';
import { tearDownStripe } from '../lib/deletion-stripe-teardown.js';
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

  const { members, tenantIds } = await resolveDeletionTargets(orgId);

  // Auth0 first: it holds the only copy of the email that keys each ALLOWLIST# row.
  // Stripe before tenant deletion, because the usage report must land on a live
  // subscription and resolves the regions from the profile. The scrub goes last:
  // it destroys the rows the earlier steps read, and a failed pass leaves the most
  // context for troubleshooting behind it.
  await tearDownAuth0(members);
  await tearDownStripe(orgId, members);
  await deleteTenants(orgId, tenantIds);
  await scrubOrgRecords(orgId, members);

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

/**
 * Before any work: `updatedAt` keeps the sweeper from re-driving a teardown that
 * is progressing, and `attempts` is the counter the blocked-deletion alert reads.
 */
async function beginPass(orgId: string): Promise<void> {
  const now = new Date().toISOString();
  await getDynamoClient().send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: deletionRecordKey(orgId),
      UpdateExpression: 'ADD attempts :one SET updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: marshall({ ':one': 1, ':now': now }),
    }),
  );

  await raiseFence(orgId, now);
}

/**
 * Re-applied each pass rather than trusted from confirm, so a deletion the
 * sweeper picked up still fences every writer even if the confirm's fence was
 * lost or the profile was rebuilt by a racing tenant-setup upsert.
 */
async function raiseFence(orgId: string, now: string): Promise<void> {
  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: `ORG#${orgId}`, sk: 'PROFILE' }),
        UpdateExpression: 'SET deleting = :true, updatedAt = :now',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: marshall({ ':true': true, ':now': now }),
      }),
    );
  } catch (err) {
    // No profile to fence. The scrub keeps it, so this only means it never existed.
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
}

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

    await orchestrator.deleteTenant(tenantId);
    console.log(`${LOG} tenant deleted`, { orgId, orchestratorId, tenantId });
  }
}

/**
 * Three actions per member whose account this deletion ends, in a fixed order:
 * read the email, revoke the grant it keys, then delete the user. The allowlist
 * row cannot be deleted afterwards — Auth0 is the only place that address is
 * stored.
 *
 * A 404 on the lookup skips the row for that member, which is safe because the
 * in-step ordering means the user is only gone once a previous pass finished the
 * removal. Deleting an already-deleted user likewise 404s and counts as success.
 *
 * A member with another membership, one who was invited into this org, and one
 * whose memberships the census could not read all keep their login and their RAG
 * grant: the org is going away, their account is not. `resolveDeletionTargets`
 * decides that per member, and the reasons it decided on are logged here.
 */
async function tearDownAuth0(members: DeletionMember[]): Promise<void> {
  for (const { sub, deleteIdentity, keptReasons } of members) {
    if (!deleteIdentity) {
      // The census's own reasons, not one of them: an account is also kept when
      // the member was only ever invited here, and when a membership row could
      // not be decoded and the census failed closed.
      console.log(`${LOG} account kept`, { sub, keptReasons });
      continue;
    }
    const email = await getAuth0UserEmail(sub);
    if (email) await revokeRagAllowlist(email);
    await deleteAuth0User(sub);
  }
}

/** Presence of the row is the grant, so deleting it revokes the grant. */
async function revokeRagAllowlist(email: string): Promise<void> {
  await getDynamoClient().send(
    new DeleteItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: ragAllowlistKey(email),
    }),
  );
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
