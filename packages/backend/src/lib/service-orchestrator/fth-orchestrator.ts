// Fortilyx (FTH) backed ServiceOrchestrator.
//
// The interface methods are intentionally split into two layers:
//   - control-plane (ensureTenantReady, isTenantReady, issueAccessKey, ...)
//     call the FTH management REST API via FthClient.
//   - data-plane (createBucket, deleteBucket, listBuckets, getBucket,
//     getPresignerContext) speak S3 directly against the FTH S3 endpoint
//     using the service access key stashed in SSM during setup.

import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
} from '@aws-sdk/client-s3';
import QuickLRU from 'quick-lru';
import { Resource } from 'sst';
import { S3Region } from '@filone/shared';
import type {
  AccessKeyPermission,
  GranularPermission,
  S3Region as S3RegionType,
} from '@filone/shared';
import { getDynamoClient } from '../ddb-client.js';
import { createFthClient, FthApiError, FthConflictError } from '../fth-client.js';
import type { FthClient } from '../fth-client.js';
import { instrumentClient } from '../fth-api-metrics.js';
import { isNotFoundError } from '../s3-errors.js';
import {
  FTH_TENANT_FINAL_SETUP_STATUS,
  isFthTenantSetupComplete,
} from '../fth-tenant-setup-status.js';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketAlreadyExistsError,
} from './service-orchestrator.js';
import type {
  BucketDetails,
  BucketSummary,
  CreateBucketArgs,
  IssueAccessKeyOpts,
  IssuedAccessKey,
  PresignerContext,
  ServiceOrchestrator,
} from './service-orchestrator.js';

const FTH_FULL_PERMISSIONS = [
  's3:CreateBucket',
  's3:ListAllMyBuckets',
  's3:DeleteBucket',
  's3:GetObject',
  's3:PutObject',
  's3:ListBucket',
  's3:DeleteObject',
] as const;

const PERMISSION_MAP: Record<AccessKeyPermission, readonly string[]> = {
  read: ['s3:GetObject', 's3:ListBucket', 's3:ListAllMyBuckets'],
  write: ['s3:PutObject'],
  list: ['s3:ListBucket', 's3:ListAllMyBuckets'],
  delete: ['s3:DeleteObject'],
};

interface FthS3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

const dynamo = getDynamoClient();
const ssm = new SSMClient({});
const ssmCache = new QuickLRU<string, string>({ maxSize: 500 });
const serviceUserCache = new QuickLRU<string, string>({ maxSize: 500 });

export const _resetFthOrchestratorCachesForTesting = () => {
  ssmCache.clear();
  serviceUserCache.clear();
};

function getStage(): string {
  return process.env.FILONE_STAGE!;
}

function getFthApiUrl(): string {
  return process.env.FTH_API_URL ?? 'https://api.fortilyx.com';
}

function getFthS3Url(): string {
  return process.env.FTH_S3_URL ?? 'https://us-east-1.fortilyx.com';
}

function createInstrumentedFthClient(): FthClient {
  const client = createFthClient({
    baseUrl: getFthApiUrl(),
    token: Resource.FthToken.value,
  });
  instrumentClient(client, { apiName: 'fth-management' });
  return client;
}

async function getFthS3Credentials(stage: string, tenantId: string): Promise<FthS3Credentials> {
  const cacheKey = `${stage}/${tenantId}`;
  const cached = ssmCache.get(cacheKey);
  if (cached) return JSON.parse(cached) as FthS3Credentials;

  let value: string | undefined;
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({
        Name: `/filone/${stage}/fth-s3/access-key/${tenantId}`,
        WithDecryption: true,
      }),
    );
    value = Parameter?.Value;
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') {
      throw new Error(`FTH S3 credentials not found in SSM for tenant ${tenantId}`, { cause: err });
    }
    throw err;
  }

  if (!value) {
    throw new Error(`FTH S3 credentials not found in SSM for tenant ${tenantId}`);
  }

  ssmCache.set(cacheKey, value);
  return JSON.parse(value) as FthS3Credentials;
}

function createS3ClientFor(ctx: PresignerContext): S3Client {
  return new S3Client({
    endpoint: ctx.endpointUrl,
    region: ctx.region,
    credentials: ctx.credentials,
    forcePathStyle: ctx.forcePathStyle,
  });
}

async function findServiceUserId(client: FthClient, tenantId: string): Promise<string> {
  const cached = serviceUserCache.get(tenantId);
  if (cached) return cached;

  const users = await client.listStorageUsers(tenantId);
  const serviceUser = users.find((u) => u.userCode === 'filone-console');
  if (!serviceUser) {
    throw new Error(
      `FTH tenant ${tenantId} has no "filone-console" storage user; call ensureTenantReady first`,
    );
  }
  serviceUserCache.set(tenantId, serviceUser.id);
  return serviceUser.id;
}

function mapPermissionsForFth(
  permissions: AccessKeyPermission[],
  granular: GranularPermission[] | undefined,
): string[] {
  const mapped = new Set<string>();
  for (const p of permissions) {
    for (const s3 of PERMISSION_MAP[p]) mapped.add(s3);
  }
  // FTH's IAM-style permissions don't model FilOne's `granularPermissions`
  // (object-version / retention / legal-hold) — they are S3 object operations
  // that ride on the same s3:GetObject / s3:PutObject permissions. Keeping
  // granular as a no-op for now; revisit if FTH adds fine-grained controls.
  void granular;
  return [...mapped];
}

export const fthOrchestrator: ServiceOrchestrator = {
  id: 'fth',
  region: S3Region.UsEast1,

  // TODO: Replace this simple create-or-skip flow with a real state machine
  // (failure-count tracking, partial-progress resumption, transitional
  // statuses from FthTenantSetupStatus) before relying on this in
  // production. See aurora-tenant-setup.ts for the pattern to mirror.
  async ensureTenantReady(orgId: string): Promise<string | null> {
    const stage = getStage();
    const key = { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } };

    const existing = await dynamo.send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: key,
        ConsistentRead: true,
      }),
    );
    const existingTenantId = existing.Item?.fthTenantId?.S;
    const existingStatus = existing.Item?.fthSetupStatus?.S;
    if (existingTenantId && isFthTenantSetupComplete(existingStatus)) {
      return existingTenantId;
    }

    const client = createInstrumentedFthClient();

    const fthClient = await client.createClient({
      externalId: orgId,
      displayName: `FilOne ${stage} ${orgId}`,
      idempotencyKey: orgId,
    });
    const tenantId = String(fthClient.id);

    // The FTH `users.email` column has a global unique index, so scope the
    // synthetic email by tenantId (which is itself unique per FTH client) to
    // avoid collisions if a previous client for this org was deleted but its
    // user row lingers. listStorageUsers first to make this step resumable
    // within the same tenant.
    const existingUsers = await client.listStorageUsers(tenantId);
    const existingServiceUser = existingUsers.find((u) => u.userCode === 'filone-console');
    const storageUser =
      existingServiceUser ??
      (await client.createStorageUser(tenantId, {
        email: `console-${tenantId}@filone.internal`,
        displayName: 'FilOne Console User',
        userCode: 'filone-console',
        role: 'storage_user',
        issueS3Credentials: false,
        idempotencyKey: `${orgId}-console-user`,
      }));

    // Access-key secrets are only returned at creation, so if a stale
    // filone-console key lingers from a partial previous run, delete it before
    // issuing a fresh one — we can't recover the old secret.
    const existingKeys = await client.listAccessKeys(tenantId);
    const staleKey = existingKeys.find((k) => k.name === 'filone-console');
    if (staleKey) {
      await client.deleteAccessKey(tenantId, staleKey.accessKeyId, {
        idempotencyKey: `${orgId}-console-key-delete`,
      });
    }

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
        UpdateExpression: 'SET fthTenantId = :tenantId, fthSetupStatus = :status, updatedAt = :now',
        ExpressionAttributeValues: {
          ':tenantId': { S: tenantId },
          ':status': { S: FTH_TENANT_FINAL_SETUP_STATUS },
          ':now': { S: new Date().toISOString() },
        },
      }),
    );

    return tenantId;
  },

  async isTenantReady(orgId: string): Promise<string | null> {
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
        ConsistentRead: true,
      }),
    );
    const tenantId = Item?.fthTenantId?.S;
    if (!tenantId) return null;
    if (!isFthTenantSetupComplete(Item?.fthSetupStatus?.S)) return null;
    return tenantId;
  },

  async getPresignerContext(tenantId: string): Promise<PresignerContext> {
    const credentials = await getFthS3Credentials(getStage(), tenantId);
    return {
      endpointUrl: getFthS3Url(),
      region: 'us-east-1',
      credentials,
      forcePathStyle: true,
    };
  },

  async createBucket(args: CreateBucketArgs): Promise<void> {
    if (args.lock) {
      throw new Error('FTH does not support object lock on bucket creation');
    }
    if (args.retention?.enabled) {
      throw new Error('FTH does not support default retention on bucket creation');
    }

    const ctx = await this.getPresignerContext(args.tenantId);
    const s3 = createS3ClientFor(ctx);
    try {
      await s3.send(new CreateBucketCommand({ Bucket: args.bucketName }));
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
        throw new BucketAlreadyExistsError(args.bucketName, { cause: err as Error });
      }
      throw err;
    }
    // Versioning is supported by FTH's S3 endpoint; toggle it after create if
    // requested. Lock/retention are intentionally rejected above.
    // The PutBucketVersioning command is omitted here to keep the demo simple;
    // add when a caller needs it.
    void args.versioning;
  },

  async deleteBucket(tenantId: string, bucketName: string): Promise<void> {
    const ctx = await this.getPresignerContext(tenantId);
    const s3 = createS3ClientFor(ctx);
    await s3.send(new DeleteBucketCommand({ Bucket: bucketName }));
  },

  async listBuckets(tenantId: string): Promise<BucketSummary[]> {
    const ctx = await this.getPresignerContext(tenantId);
    const s3 = createS3ClientFor(ctx);
    const result = await s3.send(new ListBucketsCommand({}));
    return (result.Buckets ?? [])
      .filter((b): b is typeof b & { Name: string } => !!b.Name)
      .map((b) => ({
        name: b.Name,
        createdAt: b.CreationDate?.toISOString() ?? new Date().toISOString(),
      }));
  },

  async getBucket(tenantId: string, bucketName: string): Promise<BucketDetails | null> {
    const ctx = await this.getPresignerContext(tenantId);
    const s3 = createS3ClientFor(ctx);
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    } catch (err) {
      if (isNotFoundError(err) || (err as { name?: string }).name === 'NoSuchBucket') {
        return null;
      }
      throw err;
    }

    // HeadBucket doesn't return CreationDate. Fall back to ListBuckets so we
    // can populate the field — Aurora's getBucket returns it, and orchestrator
    // callers expect a non-null createdAt.
    const list = await s3.send(new ListBucketsCommand({}));
    const found = (list.Buckets ?? []).find((b) => b.Name === bucketName);
    return {
      name: bucketName,
      createdAt: found?.CreationDate?.toISOString() ?? new Date().toISOString(),
    };
  },

  async issueAccessKey(tenantId: string, opts: IssueAccessKeyOpts): Promise<IssuedAccessKey> {
    const client = createInstrumentedFthClient();
    const serviceUserId = await findServiceUserId(client, tenantId);

    try {
      const created = await client.createAccessKey(tenantId, serviceUserId, {
        name: opts.keyName,
        permissions: mapPermissionsForFth(opts.permissions, opts.granularPermissions),
        buckets: opts.buckets ?? [],
        expiresAt: opts.expiresAt ?? null,
        idempotencyKey: `${tenantId}-${opts.keyName}`,
      });
      return {
        id: String(created.id ?? created.accessKeyId),
        accessKeyId: created.accessKeyId,
        accessKeySecret: created.secretAccessKey,
        createdAt: created.createdAt,
      };
    } catch (err) {
      if (err instanceof FthConflictError) {
        throw new AccessKeyAlreadyExistsError({ cause: err });
      }
      if (err instanceof FthApiError && err.status === 400) {
        throw new AccessKeyValidationError(err.message, { cause: err });
      }
      throw err;
    }
  },

  async findAccessKeyByName(tenantId: string, keyName: string) {
    const client = createInstrumentedFthClient();
    const keys = await client.listAccessKeys(tenantId);
    const match = keys.find((k) => k.name === keyName);
    if (!match) return undefined;
    return {
      id: String(match.id ?? match.accessKeyId),
      accessKeyId: match.accessKeyId,
      createdAt: match.createdAt,
    };
  },
};
