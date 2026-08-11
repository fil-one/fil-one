// Aurora-backed ServiceOrchestrator. Delegates to the existing per-call modules
// (aurora-tenant-setup for the lazy setup state machine, aurora-portal for
// bucket and access-key ops) and looks up SSM-cached S3 credentials directly.
//
// PROFILE-row attributes used: `auroraTenantId` and `auroraSetupStatus`.

import pRetry from 'p-retry';
import { S3Region, getS3Endpoint, TenantStatus } from '@filone/shared';
import type {
  AccessKeyPermission,
  Bucket,
  GranularPermission,
  RetentionDurationType,
  RetentionMode,
  S3Region as S3RegionType,
} from '@filone/shared';
import { getBucketInfo, listBuckets } from '@filone/aurora-portal-client';
import { ensureTenantReady as ensureAuroraTenantReady } from '../aurora/aurora-tenant-setup.js';
import {
  createAuroraAccessKey,
  createAuroraBucket,
  createPortalClient,
  deleteAuroraAccessKey,
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
  type TenantStatusResult,
} from '../aurora/aurora-backoffice.js';
import { isOrgSetupComplete } from '../org-setup-status.js';
import type { OrgProfileItem } from '../org-profile.js';
import { getConsoleS3Credentials, _resetS3CredentialsCacheForTesting } from '../s3-credentials.js';
import { BucketNotFoundError, NotImplementedError } from '../errors.js';
import type {
  BucketDetails,
  BucketSummary,
  CreateBucketArgs,
  GetTenantUsageMetricsOptions,
  IssueAccessKeyOpts,
  IssuedAccessKey,
  ListBucketsOptions,
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

export const auroraOrchestrator = {
  id: 'aurora',
  region: S3Region.EuWest1 as S3RegionType,

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

  async getTenantStatus(tenantId: string): Promise<TenantStatusProbe> {
    const result = await getAuroraTenantStatusApi({ tenantId });
    if (result.kind !== 'ok') return result;
    return {
      kind: 'ok',
      status: result.status ? mapFromModelsTenantStatus(result.status) : undefined,
    };
  },

  async deleteTenant(tenantId: string): Promise<void> {
    // Aurora exposes no tenant DELETE: this disables the tenant and verifies it
    // stayed disabled. The FilOne-held SSM secrets are retained deliberately —
    // they are the only route back to this tenant's Portal, which FIL-919's
    // deferred data deletion needs. See
    // docs/architectural-decisions/2026-08-tenant-deletion-semantics.md.
    //
    // Throwing here blocks the account's DynamoDB purge: the teardown's region
    // loop rethrows before `purgeRecords`. That is the accepted trade — a live
    // tenant must never be marked deleted — so every failure path must be
    // exitable by retrying, or say what an operator has to do.
    await pRetry(() => runAuroraTeardownAttempt(tenantId), TENANT_DELETE_RETRY);
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

  async deleteBucket(_tenantId: string, _bucketName: string): Promise<void> {
    // TODO: Implement bucket deletion.
    // https://linear.app/filecoin-foundation/issue/FIL-204/delete-bucket
    throw new NotImplementedError('Aurora bucket deletion is not yet supported. See FIL-204.');
  },

  async listBuckets(tenantId: string, opts: ListBucketsOptions = {}): Promise<BucketSummary[]> {
    // Versioning arrives inline via `flags`, so skipping it saves nothing; the
    // option exists only to keep the contract uniform with FTH.
    const includeVersioning = opts.includeVersioning ?? true;
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
        versioning: includeVersioning ? (b.flags?.includes('versioned') ?? false) : false,
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

    const defaultRetention =
      data.defaultRetention && data.defaultRetention !== 'off'
        ? (data.defaultRetention as Bucket['defaultRetention'])
        : undefined;

    return {
      bucketName: data.name ?? bucketName,
      region: auroraOrchestrator.region,
      createdAt: data.createdAt,
      isPublic: false,
      objectLockEnabled: data.objectLock ?? false,
      versioning: data.versioning ?? false,
      encrypted: data.encrypted ?? true,
      defaultRetention,
      retentionDuration: data.retentionDuration ?? undefined,
      retentionDurationType:
        (data.retentionDurationType as RetentionDurationType | undefined) ?? undefined,
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

/** One attempt: probe, disable if not already disabled, verify. */
async function runAuroraTeardownAttempt(tenantId: string): Promise<void> {
  // Raw ModelsTenantStatus, not the orchestrator-facing mapping, which collapses
  // LOCKED to `undefined` — indistinguishable from Aurora sending no status.
  const probe = await getAuroraTenantStatusApi({ tenantId });
  if (probe.kind === 'error') {
    throw new Error(`Aurora status probe failed while deleting tenant ${tenantId}`, {
      cause: probe.cause,
    });
  }
  if (probe.kind === 'not_found') {
    // The only path that reports success without verifying anything, so it warns:
    // a misconfigured backoffice client 404s a live tenant identically.
    console.warn(
      '[aurora-orchestrator] Tenant did not resolve, so the disable was never confirmed; ' +
        'treating as nothing to do. A misconfigured backoffice client 404s live tenants the ' +
        'same way, in which case this tenant is still ACTIVE',
      { tenantId },
    );
    return;
  }

  if (probe.status !== 'DISABLED') {
    await auroraOrchestrator.updateTenantStatus(tenantId, 'disabled');
  }

  await assertTenantDisabledAfterTeardown(tenantId);
}

// Throwing here is fatal to the account's data purge; see deleteTenant.
async function assertTenantDisabledAfterTeardown(tenantId: string): Promise<void> {
  const verify = await getAuroraTenantStatusApi({ tenantId });
  if (verify.kind === 'ok' && verify.status === 'DISABLED') return;

  throw new Error(
    `Aurora tenant ${tenantId} could not be confirmed DISABLED after teardown; the account's ` +
      `data purge is blocked until it can be. ${describeFailedVerification(verify)}`,
    { cause: verify.kind === 'error' ? verify.cause : undefined },
  );
}

// Says only what the probe established: a transport error or a 404 is not
// evidence of a competing writer.
function describeFailedVerification(verify: TenantStatusResult): string {
  if (verify.kind === 'error') {
    return 'The probe itself failed, so the status is unknown; usually transient, and the retry re-runs the teardown.';
  }
  if (verify.kind === 'not_found') {
    return 'The probe 404d although the tenant resolved moments earlier — the backoffice client stopped resolving mid-teardown.';
  }
  if (verify.status === 'ACTIVE' || verify.status === 'WRITE_LOCKED') {
    return `Aurora reports status=${verify.status}: a competing writer re-activated it. Retrying re-disables it.`;
  }
  if (verify.status === 'LOCKED') {
    return 'Aurora reports status=LOCKED, which is read-only rather than disabled; if it survives the retry budget an operator must set DISABLED by hand.';
  }
  return 'Aurora returned no tenant status field at all, so the teardown cannot be verified; this needs an operator, not a retry.';
}

// Aurora's metrics API accepts only m/h units.
function mapIntervalToAuroraWindow(interval: string): string {
  if (interval === '1d') return '24h';
  return interval;
}
