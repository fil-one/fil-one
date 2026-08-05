// Aurora-backed ServiceOrchestrator. Delegates to the existing per-call modules
// (aurora-tenant-setup for the lazy setup state machine, aurora-portal for
// bucket and access-key ops) and looks up SSM-cached S3 credentials directly.
//
// PROFILE-row attributes used: `auroraTenantId` and `auroraSetupStatus`.

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
  deleteAuroraPortalApiKey,
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
import {
  deleteConsoleS3Credentials,
  getConsoleS3Credentials,
  _resetS3CredentialsCacheForTesting,
} from '../s3-credentials.js';
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
    // Aurora's Backoffice/Portal APIs expose no tenant-deletion endpoint, so
    // this performs the strongest teardown available remotely: force the
    // tenant to `disabled`, revoke the console S3 key upstream, and delete
    // the FilOne-held credentials from SSM.
    const probe = await auroraOrchestrator.getTenantStatus(tenantId);
    if (probe.kind === 'error') {
      throw new Error(`Aurora status probe failed while deleting tenant ${tenantId}`, {
        cause: probe.cause,
      });
    }
    const didDisable = probe.kind === 'ok' && probe.status !== 'disabled';
    if (didDisable) {
      await auroraOrchestrator.updateTenantStatus(tenantId, 'disabled');
    }

    // Revoke the console S3 key upstream BEFORE deleting the SSM copies:
    // reaching the Portal requires the portal API key still held in SSM, so
    // once the SSM records are gone automated revocation is impossible.
    if (probe.kind === 'ok') {
      await revokeConsoleS3AccessKey(tenantId);
    }

    const stage = getStage();
    // Deletes the SSM copy AND evicts aurora-portal's warm-container cache —
    // otherwise a warm Lambda keeps serving the deleted portal API key.
    await deleteAuroraPortalApiKey(stage, tenantId);
    await deleteConsoleS3Credentials({
      orchestratorId: auroraOrchestrator.id,
      stage,
      tenantId,
    });

    // Emitted only on the run that actually disabled the tenant (not on
    // idempotent re-runs), after the work it reports has executed.
    if (didDisable) {
      console.warn(
        '[aurora-orchestrator] Aurora has no remote tenant-deletion API; the tenant was ' +
          'disabled, its console S3 key revoked, and the FilOne-held SSM secrets deleted. ' +
          'Removing the Aurora tenant itself still requires a manual backoffice step',
        { tenantId },
      );
    }
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
    // Aurora returns versioning inline via `flags`, so there's no per-bucket
    // cost to skip; the option is honored only to keep the contract uniform
    // with FTH (see ListBucketsOptions).
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

// The tenant's console S3 key is provisioned under this name by
// createAndStoreS3AccessKey in aurora-tenant-setup.ts.
const AURORA_CONSOLE_KEY_NAME = 'filone-console';

// Revokes the console S3 access key upstream (account deletion). Aurora's
// delete endpoint takes the Portal-internal key id — not the accessKeyId
// stashed in SSM — so resolve it by the well-known key name. Tolerates:
//   - an already-revoked key (listing no longer contains the name);
//   - a portal API key already removed from SSM (idempotent re-run whose
//     first pass got past revocation before cleaning SSM);
//   - a key deleted concurrently (deleteAuroraAccessKey treats 404 as done).
// Any other failure propagates so the caller retries BEFORE the SSM copies
// are deleted — after that, automated revocation is impossible.
async function revokeConsoleS3AccessKey(tenantId: string): Promise<void> {
  let key: Awaited<ReturnType<typeof findAuroraAccessKeyByName>>;
  try {
    key = await findAuroraAccessKeyByName({ tenantId, keyName: AURORA_CONSOLE_KEY_NAME });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found in SSM')) {
      console.log(
        `[aurora-orchestrator] portal API key already deleted from SSM for tenant ${tenantId}; ` +
          'skipping console S3 key revocation (a previous run already revoked it)',
      );
      return;
    }
    throw err;
  }
  if (!key) {
    console.log(
      `[aurora-orchestrator] console S3 key "${AURORA_CONSOLE_KEY_NAME}" already revoked for tenant ${tenantId}`,
    );
    return;
  }
  await deleteAuroraAccessKey({ tenantId, auroraKeyId: key.id });
}

// Aurora's metrics API only accepts windows in m/h units, so the
// orchestrator-agnostic '1d' value is translated before it hits the wire.
function mapIntervalToAuroraWindow(interval: string): string {
  if (interval === '1d') return '24h';
  return interval;
}
