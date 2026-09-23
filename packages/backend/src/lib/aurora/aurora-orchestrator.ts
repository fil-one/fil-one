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
import { ensureTenantReady as ensureAuroraTenantReady } from '../aurora/aurora-tenant-setup.ts';
import {
  createAuroraAccessKey,
  createAuroraBucket,
  createPortalClient,
  deleteAuroraAccessKey,
  deleteAuroraBucket,
  findAuroraAccessKeyByName,
} from '../aurora/aurora-portal.ts';
import {
  getOperationsSamples,
  getStorageSamples,
  getTenantStatus as getAuroraTenantStatusApi,
  mapFromModelsTenantStatus,
  mapToModelsTenantStatus,
  updateTenantStatus as updateAuroraTenantStatusApi,
  getBucketStorageSamples,
  getTenantInfo,
} from '../aurora/aurora-backoffice.ts';
import { isOrgSetupComplete } from '../org-setup-status.ts';
import type { OrgProfileItem } from '../org-profile.ts';
import { getConsoleS3Credentials, _resetS3CredentialsCacheForTesting } from '../s3-credentials.ts';
import { BucketNotFoundError } from '../errors.ts';
import type {
  BucketDetails,
  BucketProtection,
  BucketSummary,
  CreateBucketArgs,
  GetTenantUsageMetricsOptions,
  IssueAccessKeyOpts,
  IssuedAccessKey,
  OrchestratorRequestOptions,
  ServiceOrchestrator,
  TenantStatusProbe,
  StorageUsageSample,
  TenantInfo,
  TenantUsageMetrics,
} from '../service-orchestrator.ts';
import { TENANT_DELETE_RETRY } from '../service-orchestrator.ts';
import type { S3ClientContext } from '../s3-client.ts';

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
  regions: [S3Region.EuWest1 as S3RegionType],
  accessModel: 'scoped-keys',

  async ensureTenantReady(
    orgId: string,
    opts?: OrchestratorRequestOptions,
  ): Promise<string | null> {
    const result = await ensureAuroraTenantReady(orgId, opts);
    if (result.ok) return result.auroraTenantId;
    return null;
  },

  isTenantReady(orgProfile: OrgProfileItem | undefined): string | null {
    const tenantId = orgProfile?.auroraTenantId?.S;
    if (!tenantId) return null;
    if (!isOrgSetupComplete(orgProfile?.auroraSetupStatus?.S)) return null;
    return tenantId;
  },

  async updateTenantStatus(
    tenantId: string,
    status: TenantStatus,
    opts?: OrchestratorRequestOptions,
  ): Promise<void> {
    await updateAuroraTenantStatusApi({
      tenantId,
      status: mapToModelsTenantStatus(status),
      signal: opts?.signal,
    });
  },

  async deleteTenant(tenantId: string, opts?: OrchestratorRequestOptions): Promise<void> {
    // The caller's signal also stops the retry loop: once the deadline has
    // passed, every further attempt would abort on arrival.
    await pRetry(
      async () => {
        // allowMissing: a tenant that is already gone needs no disabling.
        await updateAuroraTenantStatusApi({
          tenantId,
          status: mapToModelsTenantStatus('disabled'),
          allowMissing: true,
          signal: opts?.signal,
        });
        // TODO(FIL-919): delete the tenant once Aurora's Backoffice API exposes a
        // DELETE. Until then buckets and objects survive the teardown.
      },
      { ...TENANT_DELETE_RETRY, signal: opts?.signal },
    );
  },

  async getTenantStatus(
    tenantId: string,
    opts?: OrchestratorRequestOptions,
  ): Promise<TenantStatusProbe> {
    const result = await getAuroraTenantStatusApi({ tenantId, signal: opts?.signal });
    if (result.kind !== 'ok') return result;
    return {
      kind: 'ok',
      status: result.status ? mapFromModelsTenantStatus(result.status) : undefined,
    };
  },

  async createBucket(
    tenantId: string,
    args: CreateBucketArgs,
    opts?: OrchestratorRequestOptions,
  ): Promise<void> {
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
      signal: opts?.signal,
    });
  },

  async deleteBucket(
    tenantId: string,
    bucketName: string,
    opts?: OrchestratorRequestOptions,
  ): Promise<void> {
    await deleteAuroraBucket({ tenantId, bucketName, signal: opts?.signal });
  },

  async listBuckets(tenantId: string, opts?: OrchestratorRequestOptions): Promise<BucketSummary[]> {
    const client = await createPortalClient(tenantId, { signal: opts?.signal });
    const { data, error } = await listBuckets({
      client,
      signal: opts?.signal,
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
        region: auroraOrchestrator.regions[0]!,
        createdAt: b.createdAt,
        isPublic: false,
        encrypted: b.flags?.includes('encrypted') ?? true,
      }));
  },

  async getBucket(
    tenantId: string,
    bucketName: string,
    opts?: OrchestratorRequestOptions,
  ): Promise<BucketDetails | null> {
    const client = await createPortalClient(tenantId, { signal: opts?.signal });
    const { data, error, response } = await getBucketInfo({
      client,
      signal: opts?.signal,
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
      region: auroraOrchestrator.regions[0]!,
      createdAt: data.createdAt,
      isPublic: false,
      versioning: data.versioning ?? false,
      encrypted: data.encrypted ?? true,
      ...toBucketProtection(data),
    };
  },

  async issueAccessKey(
    tenantId: string,
    keyOpts: IssueAccessKeyOpts,
    opts?: OrchestratorRequestOptions,
  ): Promise<IssuedAccessKey> {
    const key = await createAuroraAccessKey({
      tenantId,
      keyName: keyOpts.keyName,
      permissions: keyOpts.permissions as AccessKeyPermission[],
      granularPermissions: keyOpts.granularPermissions as GranularPermission[] | undefined,
      buckets: keyOpts.buckets,
      expiresAt: keyOpts.expiresAt,
      signal: opts?.signal,
    });
    return {
      id: key.id,
      accessKeyId: key.accessKeyId,
      accessKeySecret: key.accessKeySecret,
      createdAt: key.createdAt,
    };
  },

  async findAccessKeyByName(tenantId: string, keyName: string, opts?: OrchestratorRequestOptions) {
    return findAuroraAccessKeyByName({ tenantId, keyName, signal: opts?.signal });
  },

  async deleteAccessKey(
    tenantId: string,
    keyId: string,
    opts?: OrchestratorRequestOptions,
  ): Promise<void> {
    await deleteAuroraAccessKey({ tenantId, auroraKeyId: keyId, signal: opts?.signal });
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
    metricsOpts: GetTenantUsageMetricsOptions,
    opts?: OrchestratorRequestOptions,
  ): Promise<TenantUsageMetrics> {
    const window = mapIntervalToAuroraWindow(metricsOpts.interval ?? '1d');
    const { from, to } = metricsOpts;
    const signal = opts?.signal;

    const [storageSamples, operationsSamples] = await Promise.all([
      getStorageSamples({ tenantId, from, to, window, signal }),
      getOperationsSamples({ tenantId, from, to, window, signal }),
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

  async getTenantInfo(tenantId: string, opts?: OrchestratorRequestOptions): Promise<TenantInfo> {
    const info = await getTenantInfo({ tenantId, signal: opts?.signal });
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
    metricsOpts: GetTenantUsageMetricsOptions,
    opts?: OrchestratorRequestOptions,
  ): Promise<StorageUsageSample[]> {
    // getBucketStorageSamples queries Aurora metrics globally by bucket name, so
    // gate it behind a tenant-scoped ownership check: only the owning tenant's
    // Portal client resolves the bucket (404 -> null otherwise).
    const bucket = await auroraOrchestrator.getBucket(tenantId, bucketName, opts);
    if (!bucket) throw new BucketNotFoundError(bucketName);
    const auroraInterval = mapIntervalToAuroraWindow(metricsOpts.interval ?? '1d');

    const samples = await getBucketStorageSamples({
      bucketName,
      from: metricsOpts.from,
      to: metricsOpts.to,
      window: auroraInterval,
      signal: opts?.signal,
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
