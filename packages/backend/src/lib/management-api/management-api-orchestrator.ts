// Reusable ServiceOrchestrator backed by the generic Service Orchestrator
// Management API contract (docs/service-orchestrator-integration/
// management-openapi.yaml). Any orchestrator implementing that contract (the
// Forge network's Hilt is the first) is onboarded by calling
// createManagementApiOrchestrator with its config rather than writing a new
// module.
//
// The interface methods are intentionally split into two layers (same shape
// as fth-orchestrator.ts):
//   - control-plane (ensureTenantReady, issueAccessKey, tenant status/info,
//     usage metrics, ...) calls the Management API.
//   - data-plane (createBucket, listBuckets, getBucket, getS3ClientContext)
//     speaks S3 directly against the orchestrator's S3 gateway using the
//     `filone-console` system key stashed in SSM during setup.

import pRetry from 'p-retry';
import type { S3Region, TenantStatus } from '@filone/shared';
import type { AccessKeyPermission, GranularPermission } from '@filone/shared';
import {
  ensureTenantReady as ensureManagementTenantReady,
  type TenantSetupDeps,
} from './management-api-tenant-setup.js';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketConfigurationError,
  BucketNotFoundError,
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
  StorageUsageSample,
  TenantInfo,
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
import { getConsoleS3Credentials } from '../s3-credentials.js';
import {
  createManagementApiClient,
  ManagementApiConflictError,
  ManagementApiNotFoundError,
  ManagementApiValidationError,
  type ManagementApiClient,
  type ManagementMetrics,
} from './management-api-client.js';
import { instrumentClient } from './management-api-metrics.js';

export interface ManagementApiOrchestratorConfig {
  /**
   * Orchestrator id (e.g. 'forge'). Must be stable: it drives the PROFILE
   * attribute the tenant id is stored under (`${id}TenantId`), the SSM path
   * segment for console S3 credentials (`/filone/<stage>/${id}-s3/...`), and
   * the metrics apiName dimension (`${id}-management`). Future wiring
   * (registry entry, sst.config IAM blocks) must honor the same derivations.
   */
  id: string;
  region: S3Region;
  /** Deployment stage — explicit (rather than read from process.env) so instances are testable. */
  stage: string;
  /** S3 gateway endpoint for the data plane, e.g. `https://{region}.s3.fil.one`. */
  s3EndpointUrl: string;
  /** Sig V4 signing region for the S3 gateway. Defaults to `region`'s string value. */
  s3SigningRegion?: string;
  /**
   * Control-plane Management API access: either connection settings (the
   * factory builds and instruments a client) or a pre-built client (used by
   * tests and advanced callers; NOT auto-instrumented).
   */
  api: { client: ManagementApiClient } | { baseUrl: string; token: string; fetch?: typeof fetch };
}

// Versioning / object-lock are applied as separate, idempotent S3 calls after the
// bucket is created. Retry them so a transient S3 blip doesn't leave the bucket
// partially configured (which would surface as a dead-end BucketConfigurationError).
const BUCKET_CONFIG_RETRY = { retries: 3 } as const;

export function createManagementApiOrchestrator(
  config: ManagementApiOrchestratorConfig,
): ServiceOrchestrator {
  const client = resolveClient(config);
  const setupDeps: TenantSetupDeps = {
    client,
    id: config.id,
    stage: config.stage,
    region: config.region,
  };
  const tenantIdAttribute = `${config.id}TenantId`;

  const getS3ClientContext = async (tenantId: string): Promise<S3ClientContext> => {
    const credentials = await getConsoleS3Credentials({
      orchestratorId: config.id,
      stage: config.stage,
      tenantId,
    });
    return {
      endpointUrl: config.s3EndpointUrl,
      region: config.s3SigningRegion ?? config.region,
      credentials,
      forcePathStyle: true,
    };
  };

  return {
    id: config.id,
    region: config.region,

    async ensureTenantReady(orgId: string): Promise<string | null> {
      return ensureManagementTenantReady(setupDeps, orgId);
    },

    isTenantReady(orgProfile: OrgProfileItem | undefined): string | null {
      // The attribute is written last in setup, so its presence means the
      // tenant is fully provisioned (see management-api-tenant-setup.ts).
      return orgProfile?.[tenantIdAttribute]?.S ?? null;
    },

    async updateTenantStatus(tenantId: string, status: TenantStatus): Promise<void> {
      // The contract uses the same lowercase-dashed status values, so no
      // mapping is needed. Setting the same status twice is a no-op upstream;
      // transient failures are retried by the caller (region-helpers).
      await client.setTenantStatus(tenantId, { status });
    },

    async getTenantStatus(tenantId: string): Promise<TenantStatusProbe> {
      try {
        const tenant = await client.getTenant(tenantId);
        return { kind: 'ok', status: normalizeStatus(tenant.status) };
      } catch (cause) {
        if (cause instanceof ManagementApiNotFoundError) return { kind: 'not_found' };
        return { kind: 'error', cause };
      }
    },

    getS3ClientContext,
    ...buildBucketMethods(config, getS3ClientContext),
    ...buildAccessKeyMethods(client, config.id),
    ...buildMetricsMethods(client),
  } satisfies ServiceOrchestrator;
}

function resolveClient(config: ManagementApiOrchestratorConfig): ManagementApiClient {
  if ('client' in config.api) return config.api.client;
  const client = createManagementApiClient({
    baseUrl: config.api.baseUrl,
    token: config.api.token,
    ...(config.api.fetch && { fetch: config.api.fetch }),
  });
  instrumentClient(client, { apiName: `${config.id}-management` });
  return client;
}

// Data-plane bucket operations against the S3 gateway with the console key.
function buildBucketMethods(
  config: ManagementApiOrchestratorConfig,
  getS3ClientContext: (tenantId: string) => Promise<S3ClientContext>,
): Pick<ServiceOrchestrator, 'createBucket' | 'deleteBucket' | 'listBuckets' | 'getBucket'> {
  return {
    async createBucket(tenantId: string, args: CreateBucketArgs): Promise<void> {
      const ctx = await getS3ClientContext(tenantId);
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
      // The S3 gateway supports DeleteBucket (fails while non-empty), but no
      // caller exercises deletion on any orchestrator yet — parity with
      // aurora/fth. Small follow-up when the console grows the feature.
      throw new NotImplementedError('Bucket deletion is not implemented in this region yet');
    },

    async listBuckets(tenantId: string): Promise<BucketSummary[]> {
      const ctx = await getS3ClientContext(tenantId);
      const s3 = createS3Client(ctx);
      const { buckets } = await s3ListBuckets(s3);
      return Promise.all(
        buckets.map(async (b) => ({
          bucketName: b.name,
          region: config.region,
          createdAt: b.createdAt,
          isPublic: false,
          versioning: await getBucketVersioning(s3, b.name),
          // The contract mandates server-side encryption by default.
          encrypted: true,
        })),
      );
    },

    async getBucket(tenantId: string, bucketName: string): Promise<BucketDetails | null> {
      const ctx = await getS3ClientContext(tenantId);
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
        region: config.region,
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
  };
}

function buildAccessKeyMethods(
  client: ManagementApiClient,
  orchestratorId: string,
): Pick<ServiceOrchestrator, 'issueAccessKey' | 'findAccessKeyByName' | 'deleteAccessKey'> {
  return {
    async issueAccessKey(tenantId: string, opts: IssueAccessKeyOpts): Promise<IssuedAccessKey> {
      const permissions = buildPermissions(opts.permissions, opts.granularPermissions);
      const buckets = opts.buckets ?? [];

      console.log(
        `Creating ${orchestratorId} access key "${opts.keyName}" for tenant ${tenantId} with permissions ` +
          `[${permissions.join(', ')}] and bucket scopes [${buckets.join(', ')}]`,
      );

      try {
        const accessKey = await client.createAccessKey(tenantId, {
          name: opts.keyName,
          permissions,
          buckets,
          expiresAt: opts.expiresAt ?? null,
        });

        return {
          // The contract has no identifier separate from the accessKeyId.
          id: accessKey.accessKeyId,
          accessKeyId: accessKey.accessKeyId,
          accessKeySecret: accessKey.secretAccessKey,
          createdAt: accessKey.createdAt,
        };
      } catch (err) {
        if (err instanceof ManagementApiConflictError) {
          throw new AccessKeyAlreadyExistsError({ cause: err });
        }
        if (err instanceof ManagementApiValidationError) {
          throw new AccessKeyValidationError(
            extractApiMessage(err) ??
              'Invalid access key request. Check the key name and try again.',
            { cause: err },
          );
        }
        throw new Error(
          `Failed to create ${orchestratorId} access key "${opts.keyName}" for tenant ${tenantId}`,
          { cause: err },
        );
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
        await client.deleteAccessKey(tenantId, keyId);
      } catch (err) {
        if (err instanceof ManagementApiNotFoundError) {
          // The contract 404s only when the tenant is missing (key-level
          // deletes are 204 even when already gone) — either way the key no
          // longer exists, which is what the interface's idempotency needs.
          console.log(
            `${orchestratorId} access key "${keyId}" not found for tenant ${tenantId}, treating as already deleted`,
          );
          return;
        }
        throw new Error(
          `Failed to delete ${orchestratorId} access key "${keyId}" for tenant ${tenantId}`,
          { cause: err },
        );
      }
    },
  };
}

function buildMetricsMethods(
  client: ManagementApiClient,
): Pick<ServiceOrchestrator, 'getTenantUsageMetrics' | 'getTenantInfo' | 'getBucketUsageMetrics'> {
  return {
    async getTenantUsageMetrics(
      tenantId: string,
      opts: GetTenantUsageMetricsOptions,
    ): Promise<TenantUsageMetrics> {
      const metrics = await client.getTenantMetrics(tenantId, {
        from: opts.from,
        to: opts.to,
        window: mapIntervalToWindow(opts.interval ?? '1d'),
      });
      return {
        storage: mapStorageSamples(metrics),
        egress: metrics.egress.samples.map((s) => ({
          timestamp: new Date(s.timestamp).toISOString(),
          bytesUsed: s.bytesEgressed,
        })),
        // The contract also returns ingress; the interface doesn't model it.
      };
    },

    async getTenantInfo(tenantId: string): Promise<TenantInfo> {
      const tenant = await client.getTenant(tenantId);
      return {
        bucketCount: tenant.bucketCount ?? 0,
        bucketLimit: tenant.bucketLimit ?? 0,
        keyCount: tenant.accessKeyCount ?? 0,
        accessKeyLimit: tenant.accessKeyLimit ?? 0,
        status: normalizeStatus(tenant.status),
      };
    },

    async getBucketUsageMetrics(
      tenantId: string,
      bucketName: string,
      opts: GetTenantUsageMetricsOptions,
    ): Promise<StorageUsageSample[]> {
      // Unlike aurora/fth, no client-side ownership gate is needed: the
      // contract obliges the orchestrator to verify the bucket belongs to the
      // tenant and return 404 otherwise.
      try {
        const metrics = await client.getBucketMetrics(tenantId, bucketName, {
          from: opts.from,
          to: opts.to,
          window: mapIntervalToWindow(opts.interval ?? '1d'),
        });
        return mapStorageSamples(metrics);
      } catch (err) {
        if (err instanceof ManagementApiNotFoundError) {
          throw new BucketNotFoundError(bucketName, { cause: err });
        }
        throw err;
      }
    },
  };
}

const MANAGEMENT_TENANT_STATUSES: readonly TenantStatus[] = ['active', 'write-locked', 'disabled'];

// The contract's status enum is closed, but defend against noncompliant
// orchestrators: unknown values surface as `undefined` rather than leaking a
// string TenantStatus doesn't model.
function normalizeStatus(status: string | undefined): TenantStatus | undefined {
  return MANAGEMENT_TENANT_STATUSES.find((s) => s === status);
}

const ALWAYS_PERMISSIONS: readonly string[] = ['s3:ListAllMyBuckets'];

// Maps FilOne permission values onto the contract's s3:* action enum. Close
// cousin of FTH_BASE_PERMISSIONS (fth-orchestrator.ts) but deliberately not
// shared: the Management API enum has no s3:GetBucketVersioning /
// s3:GetBucketObjectLockConfiguration actions, so those FilOne permissions
// map to nothing here — sending them would draw a 422. Flagged against the
// spec; until it grows those actions, orchestrators are expected to authorize
// bucket-config reads implicitly for tenant-scoped keys.
const BASE_PERMISSIONS: Record<AccessKeyPermission, readonly string[]> = {
  read: ['s3:GetObject', 's3:ListBucket'],
  write: ['s3:PutObject'],
  list: ['s3:ListBucket'],
  delete: ['s3:DeleteObject'],
  CreateBucket: ['s3:CreateBucket'],
  DeleteBucket: ['s3:DeleteBucket'],
  GetBucketVersioning: [],
  GetBucketObjectLockConfiguration: [],
};

const GRANULAR_PERMISSIONS: Record<GranularPermission, string> = {
  GetObjectVersion: 's3:GetObjectVersion',
  GetObjectRetention: 's3:GetObjectRetention',
  GetObjectLegalHold: 's3:GetObjectLegalHold',
  PutObjectRetention: 's3:PutObjectRetention',
  PutObjectLegalHold: 's3:PutObjectLegalHold',
  ListBucketVersions: 's3:ListBucketVersions',
  DeleteObjectVersion: 's3:DeleteObjectVersion',
};

function buildPermissions(
  permissions: AccessKeyPermission[],
  granularPermissions?: GranularPermission[],
): string[] {
  const out = new Set<string>(ALWAYS_PERMISSIONS);
  for (const p of permissions) {
    const actions = BASE_PERMISSIONS[p];
    if (actions.length === 0) {
      console.warn(
        `Permission "${p}" has no Management API equivalent and was dropped from the access key request`,
      );
    }
    for (const action of actions) out.add(action);
  }
  for (const g of granularPermissions ?? []) {
    out.add(GRANULAR_PERMISSIONS[g]);
  }
  return [...out];
}

// The interface expresses sampling as an interval like '1d'/'1h'; the
// contract only accepts `<integer>h` windows. Same permissive posture as
// aurora: convert day intervals, pass hour intervals through, and let the API
// reject anything else with a 400.
function mapIntervalToWindow(interval: string): string {
  const days = /^(\d+)d$/.exec(interval);
  if (days) return `${Number(days[1]) * 24}h`;
  return interval;
}

function mapStorageSamples(metrics: ManagementMetrics): StorageUsageSample[] {
  return metrics.storage.samples.map((s) => ({
    timestamp: new Date(s.timestamp).toISOString(),
    bytesUsed: s.bytesUsed,
    objectCount: s.objectCount,
  }));
}

function extractApiMessage(err: ManagementApiValidationError): string | undefined {
  const body = err.responseBody;
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}
