// FTH tenant setup. Owned by fthOrchestrator.ensureTenantReady but kept in a
// separate module so it can grow into a real state machine (failure-count
// tracking, partial-progress resumption, transitional statuses from
// FthTenantSetupStatus) without bloating the orchestrator. See
// aurora-tenant-setup.ts for the pattern to mirror.

import { randomUUID } from 'node:crypto';
import { format } from 'node:util';
import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { Resource } from 'sst';
import { getDynamoClient } from '../ddb-client.js';
import { FthConflictError } from './fth-management-client.js';
import type {
  CreateAccessKeyArgs,
  FthAccessKeyWithSecret,
  FthManagementClient,
} from './fth-management-client.js';

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
] as const;

const CONSOLE_KEY_NAME = 'filone-console';

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

  const accessKey = await createConsoleAccessKey(client, orgId, tenantId, String(storageUser.id));

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

  await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: key,
      UpdateExpression: 'SET fthTenantId = :tenantId, updatedAt = :now',
      ExpressionAttributeValues: {
        ':tenantId': { S: tenantId },
        ':now': { S: new Date().toISOString() },
      },
    }),
  );

  return tenantId;
}

// Creates the tenant's `filone-console` S3 access key, rotating it when FTH
// reports a conflict.
//
// A 409 means a previous, partially-completed setup run already created a key
// under this name (or under this idempotency key). Its secret is unrecoverable
// — FTH returns secrets only on creation — so the stale key is useless to us
// and cannot be adopted. Rotate instead: list the storage user's keys, delete
// every `filone-console` one, and re-create under a fresh idempotency key so
// FTH treats it as a new request rather than replaying the conflict.
//
// Two concurrent setups can interleave here (one stocks SSM with a secret for
// a key the other just revoked). That window is transient and self-heals on
// the next retry through this same path; a DDB claim lock would close it
// entirely — future work, matching the state-machine TODO above.
async function createConsoleAccessKey(
  client: FthManagementClient,
  orgId: string,
  tenantId: string,
  storageUserId: string,
): Promise<FthAccessKeyWithSecret> {
  const createArgs: Omit<CreateAccessKeyArgs, 'idempotencyKey'> = {
    name: CONSOLE_KEY_NAME,
    permissions: [...FTH_FULL_PERMISSIONS],
    buckets: [],
    expiresAt: null,
  };

  try {
    return await client.createAccessKey(tenantId, storageUserId, {
      ...createArgs,
      idempotencyKey: `${orgId}-console-key`,
    });
  } catch (err) {
    if (!(err instanceof FthConflictError)) throw err;
    console.warn('[fth-tenant-setup] console key conflicted; rotating', {
      orgId,
      tenantId,
      error: format(err),
    });
  }

  const stale = (await client.listAccessKeys(tenantId)).filter((k) => k.name === CONSOLE_KEY_NAME);
  if (stale.length === 0) {
    // Conflict for a name that isn't in the listing — upstream state is
    // inconsistent, so surface it rather than looping on a create that will
    // keep conflicting.
    throw new Error(
      `Console key "${CONSOLE_KEY_NAME}" conflicted for tenant ${tenantId} ` +
        `but is absent from the access key listing`,
    );
  }

  for (const key of stale) {
    await client.deleteAccessKey(tenantId, key.accessKeyId, {
      idempotencyKey: `${orgId}-console-key-delete-${key.accessKeyId}`,
    });
  }

  return client.createAccessKey(tenantId, storageUserId, {
    ...createArgs,
    // Fresh idempotency key: reusing `${orgId}-console-key` would let FTH
    // replay the stored conflict instead of minting a new secret.
    idempotencyKey: `${orgId}-console-key-${randomUUID()}`,
  });
}
