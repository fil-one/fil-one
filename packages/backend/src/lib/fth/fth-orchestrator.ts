// Fortilyx (FTH) backed ServiceOrchestrator.
//
// The interface methods are intentionally split into two layers:
//   - control-plane (ensureTenantReady, isTenantReady, issueAccessKey, ...)
//     call the FTH management REST API. ensureTenantReady delegates to
//     fth-tenant-setup.ts; the other control-plane methods live here.
//   - data-plane (createBucket, deleteBucket, listBuckets, getBucket,
//     getS3ClientContext) speak S3 directly against the FTH S3 endpoint
//     using the service access key stashed in SSM during setup.

import pRetry from 'p-retry';
import QuickLRU from 'quick-lru';
import { Resource } from 'sst';
import { getS3Endpoint, S3Region } from '@filone/shared';
import type { AccessKeyPermission, GranularPermission } from '@filone/shared';
import { ensureTenantReady as ensureFthTenantReady } from './fth-tenant-setup.js';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketConfigurationError,
  NotImplementedError,
} from '../errors.js';
import type {
  BucketDetails,
  BucketSummary,
  CreateBucketArgs,
  GetTenantUsageMetricsOptions,
  IssueAccessKeyOpts,
  IssuedAccessKey,
  ServiceOrchestrator,
  TenantStatus,
  TenantStatusProbe,
  TenantUsageMetrics,
} from '../service-orchestrator.js';
import type { OrgProfileItem } from '../org-profile.js';

import type { S3ClientContext } from '../s3-client.js';

import { createS3Client } from '../s3-client.js';
import {
  createBucket as s3CreateBucket,
  listBuckets as s3ListBuckets,
  setBucketVersioning,
  putObjectLockConfiguration,
  getBucketVersioning,
  getBucketObjectLock,
} from '../s3-bucket-operations.js';
import { getConsoleS3Credentials, _resetS3CredentialsCacheForTesting } from '../s3-credentials.js';
import {
  createFthManagementClient,
  FthApiError,
  FthConflictError,
  FthNotFoundError,
} from './fth-management-client.js';
import type { FthManagementClient } from './fth-management-client.js';
import { instrumentClient } from './fth-api-metrics.js';

const FTH_CONSOLE_USER_CODE = 'filone-console';

// Versioning / object-lock are applied as separate, idempotent S3 calls after the
// bucket is created. Retry them so a transient S3 blip doesn't leave the bucket
// partially configured (which would surface as a dead-end BucketConfigurationError).
const BUCKET_CONFIG_RETRY = { retries: 3 } as const;

// Mirrors the retry policy of Aurora's updateTenantStatus (aurora-backoffice.ts).
const STATUS_UPDATE_RETRY = { retries: 3 } as const;

const consoleStorageUserCache = new QuickLRU<string, string>({ maxSize: 500 });
const client = createInstrumentedFthClient();

export const _resetFthOrchestratorCachesForTesting = () => {
  _resetS3CredentialsCacheForTesting();
  consoleStorageUserCache.clear();
};

export const fthOrchestrator = {
  id: 'fth',
  region: S3Region.UsEast1,

  async ensureTenantReady(orgId: string): Promise<string | null> {
    return ensureFthTenantReady(client, orgId);
  },

  isTenantReady(orgProfile: OrgProfileItem | undefined): string | null {
    const tenantId = orgProfile?.fthTenantId?.S;
    if (!tenantId) return null;
    // TODO: check fthTenantSetupStatus
    return tenantId;
  },

  async updateTenantStatus(tenantId: string, status: TenantStatus): Promise<void> {
    // FTH uses the same lowercase-dashed status values, so no mapping is needed.
    // A status PATCH is naturally idempotent, so no idempotency key is sent and
    // transient failures are safe to retry.
    await pRetry(() => client.updateClientStatus(tenantId, { status }), STATUS_UPDATE_RETRY);
  },

  async getTenantStatus(tenantId: string): Promise<TenantStatusProbe> {
    try {
      const record = await client.getClient(tenantId);
      return { kind: 'ok', status: normalizeFthStatus(record.status) };
    } catch (cause) {
      if (cause instanceof FthNotFoundError) return { kind: 'not_found' };
      return { kind: 'error', cause };
    }
  },

  async getS3ClientContext(tenantId: string): Promise<S3ClientContext> {
    const stage = process.env.FILONE_STAGE!;
    const credentials = await getConsoleS3Credentials({
      orchestratorId: fthOrchestrator.id,
      stage,
      tenantId,
    });
    return {
      endpointUrl: getS3Endpoint(fthOrchestrator.region, stage),
      region: 'us-east-1',
      credentials,
      forcePathStyle: true,
    };
  },

  async createBucket(tenantId: string, args: CreateBucketArgs): Promise<void> {
    const ctx = await fthOrchestrator.getS3ClientContext(tenantId);
    const s3 = createS3Client(ctx);
    await s3CreateBucket(s3, {
      bucketName: args.bucketName,
      objectLockEnabled: args.lock === true,
    });

    try {
      if (args.versioning) {
        await pRetry(() => setBucketVersioning(s3, args.bucketName, true), BUCKET_CONFIG_RETRY);
      }
      if (args.retention?.enabled) {
        const retention = args.retention;
        await pRetry(
          () =>
            putObjectLockConfiguration(s3, {
              bucketName: args.bucketName,
              mode: retention.mode,
              duration: retention.duration,
              durationType: retention.durationType,
            }),
          BUCKET_CONFIG_RETRY,
        );
      }
    } catch (err) {
      throw new BucketConfigurationError(args.bucketName, { cause: err });
    }
  },

  async deleteBucket(_tenantId: string, _bucketName: string): Promise<void> {
    throw new NotImplementedError('Bucket deletion is not implemented in this region yet');
  },

  async listBuckets(tenantId: string): Promise<BucketSummary[]> {
    const ctx = await fthOrchestrator.getS3ClientContext(tenantId);
    const s3 = createS3Client(ctx);
    const { buckets } = await s3ListBuckets(s3);
    return Promise.all(
      buckets.map(async (b) => ({
        bucketName: b.name,
        region: fthOrchestrator.region,
        createdAt: b.createdAt,
        isPublic: false,
        versioning: await getBucketVersioning(s3, b.name),
        encrypted: true,
      })),
    );
  },

  async getBucket(tenantId: string, bucketName: string): Promise<BucketDetails | null> {
    const ctx = await fthOrchestrator.getS3ClientContext(tenantId);
    const s3 = createS3Client(ctx);
    const { buckets } = await s3ListBuckets(s3);
    const match = buckets.find((b) => b.name === bucketName);
    if (!match) return null;

    const [versioning, lock] = await Promise.all([
      getBucketVersioning(s3, bucketName),
      getBucketObjectLock(s3, bucketName),
    ]);

    return {
      bucketName,
      region: fthOrchestrator.region,
      createdAt: match.createdAt,
      isPublic: false,
      versioning,
      encrypted: true,
      objectLockEnabled: lock?.objectLockEnabled ?? false,
      ...(lock?.defaultRetention && { defaultRetention: lock.defaultRetention }),
      ...(lock?.retentionDuration != null && { retentionDuration: lock.retentionDuration }),
      ...(lock?.retentionDurationType && { retentionDurationType: lock.retentionDurationType }),
    };
  },

  async issueAccessKey(tenantId: string, opts: IssueAccessKeyOpts): Promise<IssuedAccessKey> {
    const storageUserId = await getFthConsoleStorageUserId(tenantId);

    try {
      const accessKey = await client.createAccessKey(tenantId, storageUserId, {
        name: opts.keyName,
        permissions: buildFthPermissions(opts.permissions, opts.granularPermissions),
        buckets: opts.buckets ?? [],
        expiresAt: opts.expiresAt ?? null,
        idempotencyKey: `issue-key-${opts.keyName}`,
      });

      return {
        id: accessKey.accessKeyId,
        accessKeyId: accessKey.accessKeyId,
        accessKeySecret: accessKey.secretAccessKey,
        createdAt: accessKey.createdAt,
      };
    } catch (err) {
      if (err instanceof FthConflictError) {
        throw new AccessKeyAlreadyExistsError({ cause: err });
      }
      if (err instanceof FthApiError && err.status === 400) {
        throw new AccessKeyValidationError(
          extractFthMessage(err) ?? 'Invalid access key request. Check the key name and try again.',
          { cause: err },
        );
      }
      throw new Error(`Failed to create FTH access key "${opts.keyName}" for tenant ${tenantId}`, {
        cause: err,
      });
    }
  },

  async findAccessKeyByName(tenantId: string, keyName: string) {
    const keys = await client.listAccessKeys(tenantId);
    const match = keys.find((k) => k.name === keyName);
    if (!match) return undefined;
    return {
      id: match.accessKeyId,
      accessKeyId: match.accessKeyId,
      createdAt: match.createdAt,
    };
  },

  async deleteAccessKey(tenantId: string, keyId: string): Promise<void> {
    try {
      await client.deleteAccessKey(tenantId, keyId, { idempotencyKey: `delete-${keyId}` });
    } catch (err) {
      if (err instanceof FthNotFoundError) {
        console.log(
          `FTH access key "${keyId}" not found for tenant ${tenantId}, treating as already deleted`,
        );
        return;
      }
      throw new Error(`Failed to delete FTH access key "${keyId}" for tenant ${tenantId}`, {
        cause: err,
      });
    }
  },

  async getTenantUsageMetrics(
    tenantId: string,
    opts: GetTenantUsageMetricsOptions,
  ): Promise<TenantUsageMetrics> {
    const client = createInstrumentedFthClient();
    const res = await client.getClientMetricsTimeseries(tenantId, {
      from: opts.from,
      to: opts.to,
      interval: opts.interval ?? '1d',
    });
    const points = res.points ?? [];
    const storage = points
      .filter((p) => p.ts !== undefined)
      .map((p) => ({
        timestamp: new Date(p.ts!).toISOString(),
        bytesUsed: p.usage_avg_bytes ?? 0,
        objectCount: p.object_count_avg ?? 0,
      }));
    const egress = points
      .filter((p) => p.ts !== undefined)
      .map((p) => ({
        timestamp: new Date(p.ts!).toISOString(),
        bytesUsed: p.egress_bytes ?? 0,
      }));
    return { storage, egress };
  },
} satisfies ServiceOrchestrator;

const FTH_TENANT_STATUSES: readonly TenantStatus[] = ['active', 'write-locked', 'disabled'];

function normalizeFthStatus(status: string | undefined): TenantStatus | undefined {
  return FTH_TENANT_STATUSES.find((s) => s === status);
}

function createInstrumentedFthClient(): FthManagementClient {
  const client = createFthManagementClient({
    baseUrl: process.env.FTH_MANAGEMENT_API_URL!,
    token: Resource.FthManagementApiToken.value,
  });
  instrumentClient(client, { apiName: 'fth-management' });
  return client;
}

const FTH_ALWAYS_PERMISSIONS: readonly string[] = [
  's3:ListAllMyBuckets',
  's3:GetBucketVersioning',
  's3:GetBucketObjectLockConfiguration',
];

const FTH_BASE_PERMISSIONS: Record<AccessKeyPermission, readonly string[]> = {
  read: ['s3:GetObject', 's3:ListBucket'],
  write: ['s3:PutObject'],
  list: ['s3:ListBucket'],
  delete: ['s3:DeleteObject'],
};

const FTH_GRANULAR_PERMISSIONS: Record<GranularPermission, string> = {
  GetObjectVersion: 's3:GetObjectVersion',
  GetObjectRetention: 's3:GetObjectRetention',
  GetObjectLegalHold: 's3:GetObjectLegalHold',
  PutObjectRetention: 's3:PutObjectRetention',
  PutObjectLegalHold: 's3:PutObjectLegalHold',
  ListBucketVersions: 's3:ListBucketVersions',
  DeleteObjectVersion: 's3:DeleteObjectVersion',
};

function buildFthPermissions(
  permissions: AccessKeyPermission[],
  granularPermissions?: GranularPermission[],
): string[] {
  const out = new Set<string>(FTH_ALWAYS_PERMISSIONS);
  for (const p of permissions) {
    for (const action of FTH_BASE_PERMISSIONS[p]) out.add(action);
  }
  for (const g of granularPermissions ?? []) {
    out.add(FTH_GRANULAR_PERMISSIONS[g]);
  }
  return [...out];
}

function extractFthMessage(err: FthApiError): string | undefined {
  const body = err.responseBody;
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}

// User-issued access keys hang off the same `filone-console` storage user that
// fth-tenant-setup.ts provisions for the bootstrap console key. The storage
// user id isn't persisted on the PROFILE row, so resolve it lazily via
// listStorageUsers and memoize per warm container.
async function getFthConsoleStorageUserId(tenantId: string): Promise<string> {
  const cached = consoleStorageUserCache.get(tenantId);
  if (cached) return cached;

  const users = await client.listStorageUsers(tenantId);
  const consoleUser = users.find((u) => u.userCode === FTH_CONSOLE_USER_CODE);
  if (!consoleUser) {
    throw new Error(
      `FTH console storage user ("${FTH_CONSOLE_USER_CODE}") not found for tenant ${tenantId}`,
    );
  }
  const id = String(consoleUser.id);
  consoleStorageUserCache.set(tenantId, id);
  return id;
}
