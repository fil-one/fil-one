// Tenant setup for Management API backed orchestrators. Owned by
// createFilOneOrchestrator().ensureTenantReady but kept in a separate
// module, mirroring fth-tenant-setup.ts / aurora-tenant-setup.ts.
//
// The Management API contract makes this much simpler than Aurora's state
// machine: PUT /tenants/{tenantId} is synchronous and idempotent on a
// CLIENT-SUPPLIED UUID, so there is no upstream-minted identifier to persist
// mid-flight. FilOne derives that UUID from (orgId, region) — see tenant-id.ts
// for why it is not the orgId itself and why the derivation may never change.
// Every step is idempotent or recoverable on retry, which is why presence of
// the `${id}TenantId` PROFILE attribute (written last) is sufficient to mean
// "fully provisioned, console credentials stashed in SSM" — and why an org
// provisioned before the derivation shipped keeps its legacy id (= orgId)
// forever: the stored attribute short-circuits setup before anything derives.

import { format } from 'node:util';
import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { Resource } from 'sst';
import type { S3Region } from '@filone/shared';
import { getDynamoClient } from '../ddb-client.ts';
import { OrgDeletingError } from '../org-profile.ts';
import { resolveRefusedTenantWrite } from '../tenant-setup-fence.ts';
import { tenantIdFor } from './tenant-id.ts';
import type { OrchestratorRequestOptions } from '../service-orchestrator.ts';
import {
  deleteTenantsByTenantId,
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
  's3:ListBucketMultipartUploads',
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
  /**
   * Region the tenant is provisioned in, sent on `PUT /tenants/{tenantId}` and
   * hashed into the tenant id. Typed as the enum because a typo would derive a
   * plausible-looking wrong id rather than fail.
   */
  region: S3Region;
}

// Public entry point for synchronous tenant setup from request handlers.
// Returns the tenantId on success, or null on any setup failure so the
// handler can return the standard 503 tenant-not-ready response. Setup
// resumes from whatever step is next on the user's retry.
// `requestOptions.signal` bounds every upstream call the setup makes: the
// Management API calls (including the rollback delete) and the DynamoDB and
// SSM reads and writes.
export async function ensureTenantReady(
  deps: TenantSetupDeps,
  orgId: string,
  requestOptions?: OrchestratorRequestOptions,
): Promise<string | null> {
  const tenantId = tenantIdFor(orgId, deps.region);
  try {
    return await processTenantSetup(deps, orgId, tenantId, requestOptions);
  } catch (err) {
    // Not a setup failure: retrying will never succeed, so it must not become
    // a "try again in a moment".
    if (err instanceof OrgDeletingError) throw err;
    console.error('[tenant-setup] setup failed', {
      orchestratorId: deps.id,
      orgId,
      // No longer derivable from the orgId by eye, and it is the id to search
      // for on the orchestrator side.
      tenantId,
      error: format(err),
    });
    // TODO: record failure counter / emit metric here (mirror
    // recordSetupFailure in aurora-tenant-setup.ts).
    return null;
  }
}

async function processTenantSetup(
  deps: TenantSetupDeps,
  orgId: string,
  tenantId: string,
  requestOptions?: OrchestratorRequestOptions,
): Promise<string> {
  const { client, id, region } = deps;
  const tenantIdAttribute = `${id}TenantId`;
  const key = { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } };

  const existing = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: key,
      ConsistentRead: true,
    }),
    { abortSignal: requestOptions?.signal },
  );
  const existingTenantId = existing.Item?.[tenantIdAttribute]?.S;
  if (existingTenantId) {
    return existingTenantId;
  }

  // Before any upstream call: the tenant, its console key and its SSM secret
  // are all created below, and refusing only the pointer write at the end
  // would leave every one of them orphaned.
  if (existing.Item?.deleting?.BOOL === true) throw new OrgDeletingError(orgId);

  // Idempotent on the client-supplied tenantId: a retry after a crash derives
  // the same id (tenant-id.ts) and gets a 200 with the existing tenant instead
  // of an error.
  const { error: putError } = await putTenantsByTenantId({
    client,
    path: { tenantId },
    body: { region },
    throwOnError: false,
    ...requestOptions,
  });
  if (putError) {
    throw new Error(`Failed to provision tenant ${tenantId} for org ${orgId}`, { cause: putError });
  }

  const consoleKey = await createConsoleAccessKey(deps, tenantId, requestOptions);
  if (consoleKey) {
    await ssm.send(
      new PutParameterCommand({
        Name: consoleKeySsmPath(deps, tenantId),
        Value: JSON.stringify({
          accessKeyId: consoleKey.accessKeyId,
          secretAccessKey: consoleKey.secretAccessKey,
        }),
        Type: 'SecureString',
        Overwrite: true,
      }),
      { abortSignal: requestOptions?.signal },
    );
  }

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: key,
        UpdateExpression: 'SET #tenantIdAttr = :tenantId, updatedAt = :now',
        // UpdateItem creates the item when absent, so without attribute_exists(pk)
        // a write for an org that has no profile row would create one holding
        // nothing but a tenant id.
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleting)',
        // Names the cause for the catch — a deleting profile, or none at all —
        // without a second read.
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        ExpressionAttributeNames: {
          '#tenantIdAttr': tenantIdAttribute,
        },
        ExpressionAttributeValues: {
          ':tenantId': { S: tenantId },
          ':now': { S: new Date().toISOString() },
        },
      }),
      { abortSignal: requestOptions?.signal },
    );
  } catch (err) {
    await resolveRefusedTenantWrite({
      orgId,
      orchestratorId: id,
      tenantId,
      err,
      deleteTenant: async () => {
        const { error } = await deleteTenantsByTenantId({
          client,
          path: { tenantId },
          throwOnError: false,
          ...requestOptions,
        });
        if (error) throw new Error(`Failed to delete tenant ${tenantId}`, { cause: error });
      },
    });
  }

  return tenantId;
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
  tenantId: string,
  requestOptions?: OrchestratorRequestOptions,
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
    path: { tenantId },
    body: createArgs,
    throwOnError: false,
    ...requestOptions,
  });
  if (!created.error && created.data) {
    return created.data;
  }
  if (created.response?.status !== 409) {
    throw new Error(`Failed to create console access key for tenant ${tenantId}`, {
      cause: created.error,
    });
  }

  // 409: a previous run already created the key. Recover by inspecting the
  // listing and SSM (the contract has no Idempotency-Key header, so a crash
  // between key creation and the SSM write leaves an unrecoverable secret).
  const { data: listData, error: listError } = await getTenantsByTenantIdAccessKeys({
    client,
    path: { tenantId },
    throwOnError: false,
    ...requestOptions,
  });
  if (listError) {
    throw new Error(
      `Failed to list access keys for tenant ${tenantId} during console-key recovery`,
      {
        cause: listError,
      },
    );
  }
  const existing = (listData?.items ?? []).find((k) => k.name === CONSOLE_KEY_NAME);
  if (!existing) {
    // 409 for a name that doesn't appear in the listing — upstream is
    // inconsistent; surface the conflict rather than guessing.
    throw new Error(
      `Console key "${CONSOLE_KEY_NAME}" conflicted for tenant ${tenantId} but is absent from the key listing`,
      { cause: created.error },
    );
  }

  const stashed = await readStashedAccessKeyId(deps, tenantId, requestOptions);
  if (stashed === existing.accessKeyId) {
    // The previous run completed the SSM write; nothing left to stock.
    return null;
  }

  console.log(
    `[tenant-setup] console key "${CONSOLE_KEY_NAME}" exists for tenant ${tenantId} ` +
      `but SSM holds ${stashed ? 'stale' : 'no'} credentials; rotating the key`,
  );
  const { error: deleteError } = await deleteTenantsByTenantIdAccessKeysByAccessKeyId({
    client,
    path: { tenantId, accessKeyId: existing.accessKeyId },
    throwOnError: false,
    ...requestOptions,
  });
  if (deleteError) {
    throw new Error(`Failed to delete stale console access key for tenant ${tenantId}`, {
      cause: deleteError,
    });
  }

  const recreated = await postTenantsByTenantIdAccessKeys({
    client,
    path: { tenantId },
    body: createArgs,
    throwOnError: false,
    ...requestOptions,
  });
  if (recreated.error || !recreated.data) {
    throw new Error(`Failed to re-create console access key for tenant ${tenantId}`, {
      cause: recreated.error,
    });
  }
  return recreated.data;
}

async function readStashedAccessKeyId(
  deps: TenantSetupDeps,
  tenantId: string,
  requestOptions?: OrchestratorRequestOptions,
): Promise<string | undefined> {
  try {
    const result = await ssm.send(
      new GetParameterCommand({ Name: consoleKeySsmPath(deps, tenantId), WithDecryption: true }),
      { abortSignal: requestOptions?.signal },
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
