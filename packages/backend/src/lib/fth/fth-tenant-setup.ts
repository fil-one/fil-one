// FTH tenant setup. Owned by fthOrchestrator.ensureTenantReady but kept in a
// separate module so it can grow into a real state machine (failure-count
// tracking, partial-progress resumption, transitional statuses from
// FthTenantSetupStatus) without bloating the orchestrator. See
// aurora-tenant-setup.ts for the pattern to mirror.

import { format } from 'node:util';
import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { Resource } from 'sst';
import { getDynamoClient } from '../ddb-client.js';
import { OrgDeletingError } from '../org-profile.js';
import { resolveRefusedTenantWrite } from '../tenant-setup-fence.js';
import type { FthManagementClient } from './fth-management-client.js';

const FTH_FULL_PERMISSIONS = [
  's3:CreateBucket',
  's3:ListAllMyBuckets',
  's3:DeleteBucket',
  's3:ListBucket',
  's3:ListBucketVersions',
  's3:GetObject',
  's3:PutObject',
  's3:DeleteObject',
  's3:GetBucketVersioning',
  's3:PutBucketVersioning',
  's3:GetBucketObjectLockConfiguration',
  's3:PutBucketObjectLockConfiguration',
  's3:GetObjectRetention',
  's3:PutObjectRetention',
  's3:GetObjectLegalHold',
  's3:PutObjectLegalHold',
  's3:GetObjectVersion',
  's3:ListObjectVersions',
  's3:ListBucketMultipartUploads',
  's3:AbortMultipartUpload',
  's3:ListMultipartUploadParts',
] as const;

// The console key cannot be renamed in place: FTH requires access-key names to
// be unique within a tenant. Existing tenants get a v2 key alongside their v1
// key via bin/fth-console-key.ts, which prunes v1 once warm Lambda containers
// have stopped using it.
export const FTH_CONSOLE_KEY_NAME = 'filone-console-v2';

const dynamo = getDynamoClient();
const ssm = new SSMClient({});

// Public entry point for synchronous tenant setup from request handlers.
// Returns the fthTenantId on success, or null on any setup failure so the
// handler can return the standard 503 tenant-not-ready response. The state
// machine resumes from whatever step is next on the user's retry.
export async function ensureTenantReady(
  client: FthManagementClient,
  orgId: string,
): Promise<string | null> {
  try {
    return await processTenantSetup(client, orgId);
  } catch (err) {
    // Not a setup failure: retrying will never succeed, so it must not become
    // a "try again in a moment".
    if (err instanceof OrgDeletingError) throw err;
    console.error('[fth-tenant-setup] setup failed', {
      orgId,
      error: format(err),
    });
    // TODO: record failure counter / emit metric here once we build the
    // state machine (mirror recordSetupFailure in aurora-tenant-setup.ts).
    return null;
  }
}

// TODO: Replace this simple create-or-skip flow with a real state machine
// (failure-count tracking, partial-progress resumption, transitional
// statuses from FthTenantSetupStatus) before relying on this in
// production. See aurora-tenant-setup.ts for the pattern to mirror.
async function processTenantSetup(client: FthManagementClient, orgId: string): Promise<string> {
  const stage = process.env.FILONE_STAGE!;
  const key = { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } };

  const existing = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: key,
      ConsistentRead: true,
    }),
  );
  const existingTenantId = existing.Item?.fthTenantId?.S;
  // TODO: check fthTenantSetupStatus
  if (existingTenantId) {
    return existingTenantId;
  }

  // Before any upstream call: the tenant, its console key and its SSM secret
  // are all created below, and refusing only the pointer write at the end
  // would leave every one of them orphaned.
  if (existing.Item?.deleting?.BOOL === true) throw new OrgDeletingError(orgId);

  const fthClient = await client.createClient({
    externalId: orgId,
    displayName: `FilOne ${stage} ${orgId}`,
    idempotencyKey: orgId,
  });
  const tenantId = String(fthClient.id);

  const storageUser = await client.createStorageUser(tenantId, {
    // The FTH `users.email` column has a global unique index, so scope the
    // synthetic email by tenantId (which is itself unique per FTH client)
    email: `console-${stage}-${tenantId}@filone.internal`,
    displayName: 'FilOne Console User',
    userCode: 'filone-console',
    role: 'storage_user',
    issueS3Credentials: false,
    idempotencyKey: `console-${stage}-${tenantId}`,
  });

  const accessKey = await client.createAccessKey(tenantId, storageUser.id, {
    name: FTH_CONSOLE_KEY_NAME,
    permissions: [...FTH_FULL_PERMISSIONS],
    buckets: [],
    expiresAt: null,
    // Scoped to the tenant rather than to orgId. A key derived from orgId alone stays constant
    // while the path does not. An org that gets re-provisioned onto a new FTH client would replay
    // such a key against a path it was never minted for, and fail with 409 "idempotency key replay
    // with different payload" — permanently, since nothing about the key would ever change again.
    // The FTH client id is unique across the deployment all non-production stages share, so it
    // pins the target on its own. The `-v2` segment covers the payload change that came with
    // FTH_CONSOLE_KEY_NAME: a tenant whose setup crashed between this call and the fthTenantId
    // write would otherwise replay the pre-v2 key with the new payload and 409 forever.
    idempotencyKey: `console-key-v2-${tenantId}`,
  });

  await ssm.send(
    new PutParameterCommand({
      Name: `/filone/${stage}/fth-s3/access-key/${tenantId}`,
      Value: JSON.stringify({
        accessKeyId: accessKey.accessKeyId,
        secretAccessKey: accessKey.secretAccessKey,
      }),
      Type: 'SecureString',
      Overwrite: true,
    }),
  );

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: key,
        UpdateExpression: 'SET fthTenantId = :tenantId, updatedAt = :now',
        // UpdateItem creates the item when absent, so without attribute_exists(pk)
        // a write for an org that has no profile row would create one holding
        // nothing but a tenant id.
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleting)',
        // Names the cause for the catch — a deleting profile, or none at all —
        // without a second read.
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        ExpressionAttributeValues: {
          ':tenantId': { S: tenantId },
          ':now': { S: new Date().toISOString() },
        },
      }),
    );
  } catch (err) {
    await resolveRefusedTenantWrite({
      orgId,
      orchestratorId: 'fth',
      tenantId,
      err,
      deleteTenant: () => client.deleteClient(tenantId),
    });
  }

  return tenantId;
}
