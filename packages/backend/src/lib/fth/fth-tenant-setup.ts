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
import { createFthManagementClient } from './fth-management-client.js';
import type { FthManagementClient } from './fth-management-client.js';
import { instrumentClient } from './fth-api-metrics.js';

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

const dynamo = getDynamoClient();
const ssm = new SSMClient({});

// Public entry point for synchronous tenant setup from request handlers.
// Returns the fthTenantId on success, or null on any setup failure so the
// handler can return the standard 503 tenant-not-ready response. The state
// machine resumes from whatever step is next on the user's retry.
export async function ensureTenantReady(orgId: string): Promise<string | null> {
  try {
    return await processTenantSetup(orgId);
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
async function processTenantSetup(orgId: string): Promise<string> {
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

  const client = createInstrumentedFthClient();

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

  const accessKey = await client.createAccessKey(tenantId, String(storageUser.id), {
    name: 'filone-console',
    permissions: [...FTH_FULL_PERMISSIONS],
    buckets: [],
    expiresAt: null,
    idempotencyKey: `${orgId}-console-key`,
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

function createInstrumentedFthClient(): FthManagementClient {
  const client = createFthManagementClient({
    baseUrl: process.env.FTH_MANAGEMENT_API_URL!,
    token: Resource.FthManagementApiToken.value,
  });
  instrumentClient(client, { apiName: 'fth-management' });
  return client;
}
