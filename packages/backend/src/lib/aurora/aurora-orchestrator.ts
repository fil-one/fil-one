// Aurora-backed ServiceOrchestrator. Delegates to the existing per-call modules
// (aurora-tenant-setup for the lazy setup state machine, aurora-portal for
// bucket and access-key ops) and looks up SSM-cached S3 credentials directly.
//
// PROFILE-row attributes used: `auroraTenantId` and `auroraSetupStatus`.

import pRetry from 'p-retry';
import { S3Region, getS3Endpoint, type TenantStatus } from '@filone/shared';
import type {
  AccessKeyPermission,
  GranularPermission,
  RetentionDurationType,
  RetentionMode,
  S3Region as S3RegionType,
} from '@filone/shared';
import type { BucketBucketResponse } from '@filone/aurora-portal-client';
import { getBucketInfo, listBuckets } from '@filone/aurora-portal-client';
import { ensureTenantReady as ensureAuroraTenantReady } from '../aurora/aurora-tenant-setup.js';
import {
  createAuroraAccessKey,
  createAuroraBucket,
  createPortalClient,
  deleteAuroraAccessKey,
  deleteAuroraBucket,
  findAuroraAccessKeyByName,
} from '../aurora/aurora-portal.js';
import {
  getOperationsSamples,
  getStorageSamples,
  getTenantStatus as getAuroraTenantStatusApi,
  mapFromModelsTenantStatus,
  mapToModelsTenantStatus,
  updateTenantStatus as updateAuroraTenantStatusApi,
  getBucketStorageSamples,
  getTenantInfo,
} from '../aurora/aurora-backoffice.js';
import { isOrgSetupComplete } from '../org-setup-status.js';
import type { OrgProfileItem } from '../org-profile.js';
import { getConsoleS3Credentials, _resetS3CredentialsCacheForTesting } from '../s3-credentials.js';
import { BucketNotFoundError } from '../errors.js';
import type {
  BucketDetails,
  BucketProtection,
  BucketSummary,
  CreateBucketArgs,
  GetTenantUsageMetricsOptions,
  IssueAccessKeyOpts,
  IssuedAccessKey,
  ServiceOrchestrator,
  TenantStatusProbe,
  StorageUsageSample,
  TenantInfo,
  TenantUsageMetrics,
} from '../service-orchestrator.js';
import { TENANT_DELETE_RETRY } from '../service-orchestrator.js';
import type { S3ClientContext } from '../s3-client.js';

export const _resetSsmCacheForTesting = () => _resetS3CredentialsCacheForTesting();

function getStage(): string {
  return process.env.FILONE_STAGE!;
}

/** Object-lock and retention fields off a portal single-bucket response. */
function toBucketProtection(data: BucketBucketResponse): BucketProtection {
  return {
    objectLockEnabled: data.objectLock ?? false,
    // The portal reports "no default retention" as the string 'off'.
    defaultRetention:
      data.defaultRetention && data.defaultRetention !== 'off'
        ? (data.defaultRetention as RetentionMode)
        : undefined,
    retentionDuration: data.retentionDuration ?? undefined,
    retentionDurationType:
      (data.retentionDurationType as RetentionDurationType | undefined) ?? undefined,
  };
}

export const auroraOrchestrator = {
  id: 'aurora',
  region: S3Region.EuWest1 as S3RegionType,
  accessModel: 'scoped-keys',

  async ensureTenantReady(orgId): Promise<string | null> {
    const result = await ensureAuroraTenantReady(orgId);
    if (result.ok) return result.auroraTenantId;
    return null;
  },

  isTenantReady(orgProfile: OrgProfileItem | undefined): string | null {
    const tenantId = orgProfile?.auroraTenantId?.S;
    if (!tenantId) return null;
    if (!isOrgSetupComplete(orgProfile?.auroraSetupStatus?.S)) return null;
    return tenantId;
  },

  async updateTenantStatus(tenantId: string, status: TenantStatus): Promise<void> {
    await updateAuroraTenantStatusApi({ tenantId, status: mapToModelsTenantStatus(status) });
  },

  async deleteTenant(tenantId: string): Promise<void> {
    await pRetry(async () => {
      // allowMissing: a tenant that is already gone needs no disabling.
      await updateAuroraTenantStatusApi({
        tenantId,
        status: mapToModelsTenantStatus('disabled'),
        allowMissing: true,
      });
      // TODO(FIL-919): delete the tenant once Aurora's Backoffice API exposes a
      // DELETE. Until then buckets and objects survive the teardown.
    }, TENANT_DELETE_RETRY);
  },

  async getTenantStatus(tenantId: string): Promise<TenantStatusProbe> {
    const result = await getAuroraTenantStatusApi({ tenantId });
    if (result.kind !== 'ok') return result;
    return {
      kind: 'ok',
      status: result.status ? mapFromModelsTenantStatus(result.status) : undefined,
    };
  },

  async createBucket(tenantId: string, args: CreateBucketArgs): Promise<void> {
    await createAuroraBucket({
      tenantId,
      bucketName: args.bucketName,
      versioning: args.versioning,
      lock: args.lock,
      retention: args.retention as
        | {
            enabled: boolean;
            mode: RetentionMode;
            duration: number;
            durationType: RetentionDurationType;
          }
        | undefined,
    });
  },

  async deleteBucket(tenantId: string, bucketName: string): Promise<void> {
    await deleteAuroraBucket({ tenantId, bucketName });
  },

  async listBuckets(tenantId: string): Promise<BucketSummary[]> {
    const client = await createPortalClient(tenantId);
    const { data, error } = await listBuckets({
      client,
      path: { tenantId },
      throwOnError: false,
    });

    if (error) {
      throw new Error(`Failed to list buckets from Aurora for tenant ${tenantId}`, {
        cause: error,
      });
    }

    return (data?.items ?? [])
      .filter((b): b is typeof b & { name: string; createdAt: string } => !!b.name && !!b.createdAt)
      .map((b) => ({
        bucketName: b.name,
        region: auroraOrchestrator.region,
        createdAt: b.createdAt,
        isPublic: false,
        encrypted: b.flags?.includes('encrypted') ?? true,
      }));
  },

  async getBucket(tenantId: string, bucketName: string): Promise<BucketDetails | null> {
    const client = await createPortalClient(tenantId);
    const { data, error, response } = await getBucketInfo({
      client,
      path: { tenantId, bucketName },
      throwOnError: false,
    });

    if (error) {
      if (response?.status === 404) return null;
      throw new Error(`Failed to get bucket "${bucketName}" from Aurora for tenant ${tenantId}`, {
        cause: error,
      });
    }

    if (!data?.createdAt) {
      throw new Error(
        `Aurora returned incomplete data for bucket "${bucketName}" (tenant ${tenantId})`,
      );
    }

    return {
      bucketName: data.name ?? bucketName,
      region: auroraOrchestrator.region,
      createdAt: data.createdAt,
      isPublic: false,
      versioning: data.versioning ?? false,
      encrypted: data.encrypted ?? true,
      ...toBucketProtection(data),
    };
  },

  async issueAccessKey(tenantId: string, opts: IssueAccessKeyOpts): Promise<IssuedAccessKey> {
    const key = await createAuroraAccessKey({
      tenantId,
      keyName: opts.keyName,
      permissions: opts.permissions as AccessKeyPermission[],
      granularPermissions: opts.granularPermissions as GranularPermission[] | undefined,
      buckets: opts.buckets,
      expiresAt: opts.expiresAt,
    });
    return {
      id: key.id,
      accessKeyId: key.accessKeyId,
      accessKeySecret: key.accessKeySecret,
      createdAt: key.createdAt,
    };
  },

  async findAccessKeyByName(tenantId: string, keyName: string) {
    return findAuroraAccessKeyByName({ tenantId, keyName });
  },

  async deleteAccessKey(tenantId: string, keyId: string): Promise<void> {
    await deleteAuroraAccessKey({ tenantId, auroraKeyId: keyId });
  },

  async getS3ClientContext(tenantId: string): Promise<S3ClientContext> {
    const stage = getStage();
    const credentials = await getConsoleS3Credentials({
      orchestratorId: auroraOrchestrator.id,
      stage,
      tenantId,
    });
    return {
      endpointUrl: getS3Endpoint(S3Region.EuWest1, stage),
      region: 'auto',
      credentials,
      forcePathStyle: true,
      orchestratorId: auroraOrchestrator.id,
      tenantId,
    };
  },

  async getTenantUsageMetrics(
    tenantId: string,
    opts: GetTenantUsageMetricsOptions,
  ): Promise<TenantUsageMetrics> {
    const window = mapIntervalToAuroraWindow(opts.interval ?? '1d');
    const { from, to } = opts;

    const [storageSamples, operationsSamples] = await Promise.all([
      getStorageSamples({ tenantId, from, to, window }),
      getOperationsSamples({ tenantId, from, to, window }),
    ]);

    const storage = storageSamples
      .filter((s): s is typeof s & { timestamp: string } => s.timestamp !== undefined)
      .map((s) => ({
        timestamp: new Date(s.timestamp).toISOString(),
        bytesUsed: s.bytesUsed ?? 0,
        objectCount: s.objectCount ?? 0,
      }));

    const egress = operationsSamples
      .filter((s): s is typeof s & { timestamp: string } => s.timestamp !== undefined)
      .map((s) => ({
        timestamp: new Date(s.timestamp).toISOString(),
        bytesUsed: s.txBytes ?? 0,
      }));

    return { storage, egress };
  },

  async getTenantInfo(tenantId: string): Promise<TenantInfo> {
    const info = await getTenantInfo({ tenantId });
    return {
      bucketCount: info.bucketCount ?? 0,
      bucketLimit: info.bucketQuantityLimit ?? 100,
      keyCount: info.keyCount ?? 0,
      accessKeyLimit: info.accessKeyQuantityLimit ?? 300,
      status: mapFromModelsTenantStatus(info.status),
    };
  },

  async getBucketUsageMetrics(
    tenantId: string,
    bucketName: string,
    opts: GetTenantUsageMetricsOptions,
  ): Promise<StorageUsageSample[]> {
    // getBucketStorageSamples queries Aurora metrics globally by bucket name, so
    // gate it behind a tenant-scoped ownership check: only the owning tenant's
    // Portal client resolves the bucket (404 -> null otherwise).
    const bucket = await auroraOrchestrator.getBucket(tenantId, bucketName);
    if (!bucket) throw new BucketNotFoundError(bucketName);
    const auroraInterval = mapIntervalToAuroraWindow(opts.interval ?? '1d');

    const samples = await getBucketStorageSamples({
      bucketName,
      from: opts.from,
      to: opts.to,
      window: auroraInterval,
    });

    return samples
      .filter((s): s is typeof s & { timestamp: string } => s.timestamp !== undefined)
      .map((s) => ({
        timestamp: new Date(s.timestamp).toISOString(),
        bytesUsed: s.bytesUsed ?? 0,
        objectCount: s.objectCount ?? 0,
      }));
  },
} satisfies ServiceOrchestrator;

// Aurora's metrics API only accepts windows in m/h units, so the
// orchestrator-agnostic '1d' value is translated before it hits the wire.
function mapIntervalToAuroraWindow(interval: string): string {
  if (interval === '1d') return '24h';
  return interval;
}
