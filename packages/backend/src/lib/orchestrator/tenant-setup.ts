// Tenant setup for Management API backed orchestrators. Owned by
// createFilOneOrchestrator().ensureTenantReady but kept in a separate
// module, mirroring fth-tenant-setup.ts / aurora-tenant-setup.ts.
//
// The Management API contract makes this much simpler than Aurora's state
// machine: PUT /tenants/{tenantId} is synchronous and idempotent on a
// CLIENT-SUPPLIED UUID, and FilOne uses the orgId verbatim — so tenantId ===
// orgId and there is no upstream-minted identifier to persist mid-flight.
// Every step is idempotent or recoverable on retry, which is why presence of
// the `${id}TenantId` PROFILE attribute (written last) is sufficient to mean
// "fully provisioned, console credentials stashed in SSM".

import { format } from 'node:util';
import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { Resource } from 'sst';
import { getDynamoClient } from '../ddb-client.js';
import {
  deleteTenantsByTenantIdAccessKeysByAccessKeyId,
  getTenantsByTenantIdAccessKeys,
  postTenantsByTenantIdAccessKeys,
  putTenantsByTenantId,
  type Client,
  type CreateAccessKeyRequest,
  type CreatedAccessKey,
} from '@filone/orchestrator-client';

export const CONSOLE_KEY_NAME = 'filone-console';

// The contract-legal maximum: every action in the Management API's
// AccessKeyPermission enum. Note the contract (unlike FTH) has no
// s3:Get/PutBucketVersioning or s3:Get/PutBucketObjectLockConfiguration
// actions, yet the console key drives exactly those S3 calls for bucket
// create/get/list — orchestrators are expected to authorize bucket-config
// operations implicitly for tenant-scoped keys (flagged against the spec).
const CONSOLE_KEY_PERMISSIONS = [
  's3:CreateBucket',
  's3:ListAllMyBuckets',
  's3:DeleteBucket',
  's3:GetObject',
  's3:GetObjectVersion',
  's3:GetObjectRetention',
  's3:GetObjectLegalHold',
  's3:PutObject',
  's3:PutObjectRetention',
  's3:PutObjectLegalHold',
  's3:ListBucket',
  's3:ListBucketVersions',
  's3:DeleteObject',
  's3:DeleteObjectVersion',
] as const;

const dynamo = getDynamoClient();
const ssm = new SSMClient({});

export interface TenantSetupDeps {
  client: Client;
  /** Orchestrator id — drives the SSM path (`${id}-s3`) and PROFILE attribute (`${id}TenantId`). */
  id: string;
  stage: string;
  /** Region the tenant is provisioned in, sent on `PUT /tenants/{tenantId}`. */
  region: string;
}

// Public entry point for synchronous tenant setup from request handlers.
// Returns the tenantId on success, or null on any setup failure so the
// handler can return the standard 503 tenant-not-ready response. Setup
// resumes from whatever step is next on the user's retry.
export async function ensureTenantReady(
  deps: TenantSetupDeps,
  orgId: string,
): Promise<string | null> {
  try {
    return await processTenantSetup(deps, orgId);
  } catch (err) {
    console.error('[tenant-setup] setup failed', {
      orchestratorId: deps.id,
      orgId,
      error: format(err),
    });
    // TODO: record failure counter / emit metric here (mirror
    // recordSetupFailure in aurora-tenant-setup.ts).
    return null;
  }
}

async function processTenantSetup(deps: TenantSetupDeps, orgId: string): Promise<string> {
  const { client, id, region } = deps;
  const tenantIdAttribute = `${id}TenantId`;
  const key = { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } };

  const existing = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: key,
      ConsistentRead: true,
    }),
  );
  const existingTenantId = existing.Item?.[tenantIdAttribute]?.S;
  if (existingTenantId) {
    return existingTenantId;
  }

  // Idempotent on the client-supplied tenantId (= orgId): a retry after a
  // crash gets a 200 with the existing tenant instead of an error.
  const { error: putError } = await putTenantsByTenantId({
    client,
    path: { tenantId: orgId },
    body: { region },
    throwOnError: false,
  });
  if (putError) {
    throw new Error(`Failed to provision tenant ${orgId}`, { cause: putError });
  }

  const consoleKey = await createConsoleAccessKey(deps, orgId);
  if (consoleKey) {
    await ssm.send(
      new PutParameterCommand({
        Name: consoleKeySsmPath(deps, orgId),
        Value: JSON.stringify({
          accessKeyId: consoleKey.accessKeyId,
          secretAccessKey: consoleKey.secretAccessKey,
        }),
        Type: 'SecureString',
        Overwrite: true,
      }),
    );
  }

  await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: key,
      UpdateExpression: 'SET #tenantIdAttr = :tenantId, updatedAt = :now',
      ExpressionAttributeNames: {
        '#tenantIdAttr': tenantIdAttribute,
      },
      ExpressionAttributeValues: {
        ':tenantId': { S: orgId },
        ':now': { S: new Date().toISOString() },
      },
    }),
  );

  return orgId;
}

// Creates the per-tenant `filone-console` system key. Returns the created key
// (secret included) when SSM still needs stocking, or null when a previous
// run already stocked SSM with this key's credentials.
//
// The contract has no Idempotency-Key header, so a crash between key creation
// and the SSM write leaves a key whose secret is unrecoverable (secrets are
// returned only on creation). The retry then hits 409 on the duplicate name
// and recovers here:
//   - if SSM already holds credentials for the existing key's accessKeyId,
//     the previous run got past the SSM write — reuse it;
//   - otherwise delete the orphaned key (204 even if already gone) and
//     re-create it to obtain a fresh secret.
// Two concurrent setups can interleave in the delete/re-create branch
// (one stashes a secret for a key the other just revoked); that window is
// transient and self-heals on the next retry via this same branch. A DDB
// claim lock would close it entirely — future work, matching FTH's TODO.
async function createConsoleAccessKey(
  deps: TenantSetupDeps,
  orgId: string,
): Promise<CreatedAccessKey | null> {
  const { client } = deps;
  const createArgs: CreateAccessKeyRequest = {
    name: CONSOLE_KEY_NAME,
    permissions: [...CONSOLE_KEY_PERMISSIONS],
    buckets: [],
    expiresAt: null,
  };

  const created = await postTenantsByTenantIdAccessKeys({
    client,
    path: { tenantId: orgId },
    body: createArgs,
    throwOnError: false,
  });
  if (!created.error && created.data) {
    return created.data;
  }
  if (created.response?.status !== 409) {
    throw new Error(`Failed to create console access key for tenant ${orgId}`, {
      cause: created.error,
    });
  }

  // 409: a previous run already created the key. Recover by inspecting the
  // listing and SSM (the contract has no Idempotency-Key header, so a crash
  // between key creation and the SSM write leaves an unrecoverable secret).
  const { data: listData, error: listError } = await getTenantsByTenantIdAccessKeys({
    client,
    path: { tenantId: orgId },
    throwOnError: false,
  });
  if (listError) {
    throw new Error(`Failed to list access keys for tenant ${orgId} during console-key recovery`, {
      cause: listError,
    });
  }
  const existing = (listData?.items ?? []).find((k) => k.name === CONSOLE_KEY_NAME);
  if (!existing) {
    // 409 for a name that doesn't appear in the listing — upstream is
    // inconsistent; surface the conflict rather than guessing.
    throw new Error(
      `Console key "${CONSOLE_KEY_NAME}" conflicted for tenant ${orgId} but is absent from the key listing`,
      { cause: created.error },
    );
  }

  const stashed = await readStashedAccessKeyId(deps, orgId);
  if (stashed === existing.accessKeyId) {
    // The previous run completed the SSM write; nothing left to stock.
    return null;
  }

  console.log(
    `[tenant-setup] console key "${CONSOLE_KEY_NAME}" exists for tenant ${orgId} ` +
      `but SSM holds ${stashed ? 'stale' : 'no'} credentials; rotating the key`,
  );
  const { error: deleteError } = await deleteTenantsByTenantIdAccessKeysByAccessKeyId({
    client,
    path: { tenantId: orgId, accessKeyId: existing.accessKeyId },
    throwOnError: false,
  });
  if (deleteError) {
    throw new Error(`Failed to delete stale console access key for tenant ${orgId}`, {
      cause: deleteError,
    });
  }

  const recreated = await postTenantsByTenantIdAccessKeys({
    client,
    path: { tenantId: orgId },
    body: createArgs,
    throwOnError: false,
  });
  if (recreated.error || !recreated.data) {
    throw new Error(`Failed to re-create console access key for tenant ${orgId}`, {
      cause: recreated.error,
    });
  }
  return recreated.data;
}

async function readStashedAccessKeyId(
  deps: TenantSetupDeps,
  orgId: string,
): Promise<string | undefined> {
  try {
    const result = await ssm.send(
      new GetParameterCommand({ Name: consoleKeySsmPath(deps, orgId), WithDecryption: true }),
    );
    if (!result.Parameter?.Value) return undefined;
    const parsed: unknown = JSON.parse(result.Parameter.Value);
    if (parsed && typeof parsed === 'object' && 'accessKeyId' in parsed) {
      const accessKeyId = (parsed as { accessKeyId?: unknown }).accessKeyId;
      if (typeof accessKeyId === 'string') return accessKeyId;
    }
    return undefined;
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

// Must match the path getConsoleS3Credentials (lib/s3-credentials.ts) reads.
function consoleKeySsmPath(deps: TenantSetupDeps, tenantId: string): string {
  return `/filone/${deps.stage}/${deps.id}-s3/access-key/${tenantId}`;
}
