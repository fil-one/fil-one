// Aurora-backed ServiceOrchestrator. Delegates to the existing per-call modules
// (aurora-tenant-setup for the lazy setup state machine, aurora-portal for
// bucket and access-key ops, aurora-s3-client for SSM-cached S3 credentials).
//
// PROFILE-row attributes used: `auroraTenantId`, `setupStatus`,
// `setupFailureCount` — unchanged from before this refactor so existing
// production tenants keep working with no migration.

import { S3Region, getS3Endpoint } from '@filone/shared';
import type {
  AccessKeyPermission,
  Bucket,
  GranularPermission,
  RetentionDurationType,
  RetentionMode,
  S3Region as S3RegionType,
} from '@filone/shared';
import { createClient, getBucketInfo, listBuckets } from '@filone/aurora-portal-client';
import { ensureTenantReady as ensureAuroraTenantReady } from '../aurora-tenant-setup.js';
import {
  AuroraValidationError,
  BucketAlreadyExistsError as PortalBucketAlreadyExistsError,
  createAuroraAccessKey,
  createAuroraBucket,
  DuplicateKeyNameError,
  findAuroraAccessKeyByName,
  getAuroraPortalApiKey,
} from '../aurora-portal.js';
import { deleteBucket as s3DeleteBucket, getAuroraS3Credentials } from '../aurora-s3-client.js';
import { isOrgSetupComplete } from '../org-setup-status.js';
import { readTenantAttrs } from './profile-tenant.js';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketAlreadyExistsError,
} from './service-orchestrator.js';
import type {
  BucketDetails,
  BucketSummary,
  CreateBucketArgs,
  EnsureTenantReadyResult,
  IssueAccessKeyOpts,
  IssuedAccessKey,
  PresignerContext,
  ServiceOrchestrator,
} from './service-orchestrator.js';

function getStage(): string {
  return process.env.FILONE_STAGE!;
}

function getPortalBaseUrl(): string {
  return process.env.AURORA_PORTAL_URL!;
}

async function createPortalReadClient(tenantId: string) {
  const apiKey = await getAuroraPortalApiKey(getStage(), tenantId);
  return createClient({
    baseUrl: getPortalBaseUrl(),
    headers: { 'X-Api-Key': apiKey },
  });
}

export const auroraOrchestrator: ServiceOrchestrator = {
  id: 'aurora',
  region: S3Region.EuWest1 as S3RegionType,

  async ensureTenantReady(orgId): Promise<EnsureTenantReadyResult> {
    const result = await ensureAuroraTenantReady(orgId);
    if (result.ok) return { ok: true, tenantId: result.auroraTenantId };
    // aurora-tenant-setup currently builds a 503 APIGateway response for any
    // setup failure (still-running, transient API error, etc.). At the
    // abstraction boundary we collapse all of those into the single
    // 'setup-incomplete' reason; handlers translate that into HTTP.
    return { ok: false, reason: 'setup-incomplete' };
  },

  async isTenantReady(orgId): Promise<{ tenantId: string } | null> {
    const attrs = await readTenantAttrs(
      orgId,
      {
        statusAttr: 'setupStatus',
        tenantIdAttr: 'auroraTenantId',
        failureCountAttr: 'setupFailureCount',
      },
      { consistent: true },
    );
    if (!attrs?.tenantId) return null;
    if (!isOrgSetupComplete(attrs.setupStatus)) return null;
    return { tenantId: attrs.tenantId };
  },

  async createBucket(args: CreateBucketArgs): Promise<void> {
    try {
      await createAuroraBucket({
        tenantId: args.tenantId,
        bucketName: args.name,
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
    } catch (err) {
      if (err instanceof PortalBucketAlreadyExistsError) {
        throw new BucketAlreadyExistsError(args.name);
      }
      throw err;
    }
  },

  async deleteBucket(tenantId: string, name: string): Promise<void> {
    const ctx = await this.getPresignerContext(tenantId);
    await s3DeleteBucket(ctx.endpointUrl, ctx.credentials, name);
  },

  async listBuckets(tenantId: string): Promise<BucketSummary[]> {
    const client = await createPortalReadClient(tenantId);
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
        name: b.name,
        createdAt: b.createdAt,
        versioning: b.flags?.includes('versioned') ?? false,
        encrypted: b.flags?.includes('encrypted') ?? true,
      }));
  },

  async getBucket(tenantId: string, name: string): Promise<BucketDetails | null> {
    const client = await createPortalReadClient(tenantId);
    const { data, error, response } = await getBucketInfo({
      client,
      path: { tenantId, bucketName: name },
      throwOnError: false,
    });

    if (error) {
      if (response?.status === 404) return null;
      throw new Error(`Failed to get bucket "${name}" from Aurora for tenant ${tenantId}`, {
        cause: error,
      });
    }

    if (!data?.createdAt) {
      throw new Error(`Aurora returned incomplete data for bucket "${name}" (tenant ${tenantId})`);
    }

    const defaultRetention =
      data.defaultRetention && data.defaultRetention !== 'off'
        ? (data.defaultRetention as Bucket['defaultRetention'])
        : undefined;

    return {
      name: data.name ?? name,
      createdAt: data.createdAt,
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
    try {
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
    } catch (err) {
      if (err instanceof DuplicateKeyNameError) {
        throw new AccessKeyAlreadyExistsError();
      }
      if (err instanceof AuroraValidationError) {
        throw new AccessKeyValidationError(err.message);
      }
      throw err;
    }
  },

  async findAccessKeyByName(tenantId: string, keyName: string) {
    return findAuroraAccessKeyByName({ tenantId, keyName });
  },

  async getPresignerContext(tenantId: string): Promise<PresignerContext> {
    const stage = getStage();
    const credentials = await getAuroraS3Credentials(stage, tenantId);
    return {
      endpointUrl: getS3Endpoint(S3Region.EuWest1, stage),
      region: 'auto',
      credentials,
      forcePathStyle: true,
    };
  },
};
