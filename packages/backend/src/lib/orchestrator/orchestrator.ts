// Reusable ServiceOrchestrator backed by the generic Service Orchestrator
// Management API contract (docs/service-orchestrator-integration/
// management-openapi.yaml). Any orchestrator implementing that contract (the
// Forge network's Hilt is the first) is onboarded by calling
// createFilOneOrchestrator with its config rather than writing a new
// module.
//
// The interface methods are intentionally split into two layers (same shape
// as fth-orchestrator.ts):
//   - control-plane (ensureTenantReady, issueAccessKey, tenant status/info,
//     usage metrics, ...) calls the Management API.
//   - data-plane (createBucket, listBuckets, getBucket, getS3ClientContext)
//     speaks S3 directly against the S3 gateway of the region named in the
//     call, using the `filone-console` system key stashed in SSM during setup.
//     The tenant is region-free, so that one key works at every region's
//     gateway; only the endpoint and signing region change.

import pRetry from 'p-retry';
import { getS3Endpoint, type S3Region, type TenantStatus } from '@filone/shared';
import {
  ensureTenantReady as ensureManagementTenantReady,
  type TenantSetupDeps,
} from './tenant-setup.ts';
import { buildPermissions } from './permissions.ts';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketConfigurationError,
  BucketNotFoundError,
} from '../errors.ts';
import type {
  BucketDetails,
  BucketSummary,
  CreateBucketArgs,
  GetTenantUsageMetricsOptions,
  IssueAccessKeyOpts,
  IssuedAccessKey,
  OrchestratorRequestOptions,
  ServiceOrchestrator,
  StorageUsageSample,
  TenantInfo,
  TenantStatusProbe,
  TenantUsageMetrics,
} from '../service-orchestrator.ts';
import { TENANT_DELETE_RETRY } from '../service-orchestrator.ts';
import type { OrgProfileItem } from '../org-profile.ts';
import type { S3ClientContext } from '../s3-client.ts';
import { createS3Client } from '../s3-client.ts';
import {
  createBucket as s3CreateBucket,
  listBuckets as s3ListBuckets,
  deleteBucket as s3DeleteBucket,
  setBucketVersioning,
  putObjectLockConfiguration,
  getBucketVersioning,
  getBucketObjectLock,
} from '../s3-bucket-operations.ts';
import { getConsoleS3Credentials } from '../s3-credentials.ts';
import {
  createClient,
  deleteTenantsByTenantId,
  deleteTenantsByTenantIdAccessKeysByAccessKeyId,
  getTenantsByTenantId,
  getTenantsByTenantIdAccessKeys,
  getTenantsByTenantIdBucketsByBucketNameMetrics,
  getTenantsByTenantIdMetrics,
  postTenantsByTenantIdAccessKeys,
  postTenantsByTenantIdStatus,
  type Client,
  type CreateAccessKeyRequest,
} from '@filone/orchestrator-client';
import { instrumentClient } from './metrics.ts';
import {
  extractApiMessage,
  mapIntervalToWindow,
  mapStorageSamples,
  normalizeStatus,
} from './mapping.ts';

export interface FilOneOrchestratorConfig {
  /**
   * Orchestrator id (e.g. 'forge'). Must be stable: it drives the PROFILE
   * attribute the tenant id is stored under (`${id}TenantId`), the SSM path
   * segment for console S3 credentials (`/filone/<stage>/${id}-s3/...`), and
   * the metrics apiName dimension (`${id}-management`). Future wiring
   * (registry entry, sst.config IAM blocks) must honor the same derivations.
   */
  id: string;
  /**
   * The regions the network serves. The S3 gateway endpoint is derived from a
   * region with `getS3Endpoint`.
   */
  regions: S3Region[];
  /** Deployment stage — explicit (rather than read from process.env) so instances are testable. */
  stage: string;
  /**
   * Control-plane Management API access: either connection settings (the
   * factory builds and instruments a client) or a pre-built client (used by
   * tests and advanced callers; NOT auto-instrumented).
   */
  api: { client: Client } | { baseUrl: string; accessToken: string; fetch?: typeof fetch };
}

// Versioning / object-lock are applied as separate, idempotent S3 calls after the
// bucket is created. Retry them so a transient S3 blip doesn't leave the bucket
// partially configured (which would surface as a dead-end BucketConfigurationError).
const BUCKET_CONFIG_RETRY = { retries: 3 } as const;

export function createFilOneOrchestrator(config: FilOneOrchestratorConfig): ServiceOrchestrator {
  return new FilOneOrchestrator(config);
}

class FilOneOrchestrator implements ServiceOrchestrator {
  readonly id: string;
  readonly regions: S3Region[];
  readonly accessModel = 'scoped-keys';

  private readonly config: FilOneOrchestratorConfig;
  private readonly client: Client;
  private readonly setupDeps: TenantSetupDeps;
  private readonly tenantIdAttribute: string;

  constructor(config: FilOneOrchestratorConfig) {
    this.config = config;
    if (config.regions.length === 0) {
      throw new Error(`Orchestrator "${config.id}" must serve at least one region.`);
    }
    this.id = config.id;
    this.regions = config.regions;
    this.client = resolveClient(config);
    this.setupDeps = {
      client: this.client,
      id: config.id,
      stage: config.stage,
    };
    this.tenantIdAttribute = `${config.id}TenantId`;
  }

  // Same lowercase-dashed status values as the contract, so no mapping is
  // needed. Setting the same status twice is a no-op upstream.
  private async setTenantStatus(
    tenantId: string,
    status: TenantStatus,
    {
      allowMissing,
      ...requestOptions
    }: { allowMissing?: boolean } & OrchestratorRequestOptions = {},
  ): Promise<void> {
    const { error, response } = await postTenantsByTenantIdStatus({
      client: this.client,
      path: { tenantId },
      body: { status },
      throwOnError: false,
      ...requestOptions,
    });
    if (!error) return;
    if (allowMissing && response?.status === 404) return;
    throw new Error(`Failed to set tenant ${tenantId} status to "${status}"`, { cause: error });
  }

  // A region this network does not serve has no gateway to send the request to;
  // reaching one is a routing bug upstream, not something to sign for anyway.
  private assertServes(region: S3Region): void {
    if (!this.regions.includes(region)) {
      throw new Error(`Orchestrator "${this.id}" does not serve region "${region}".`);
    }
  }

  async getS3ClientContext(
    tenantId: string,
    region: S3Region,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<S3ClientContext> {
    this.assertServes(region);
    const credentials = await getConsoleS3Credentials(
      {
        orchestratorId: this.id,
        stage: this.config.stage,
        tenantId,
      },
      requestOptions,
    );
    return {
      endpointUrl: getS3Endpoint(region, this.config.stage),
      region,
      credentials,
      forcePathStyle: true,
      orchestratorId: this.id,
      tenantId,
    };
  }

  async ensureTenantReady(
    orgId: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<string | null> {
    return ensureManagementTenantReady(this.setupDeps, orgId, requestOptions);
  }

  isTenantReady(orgProfile: OrgProfileItem | undefined): string | null {
    // The attribute is written last in setup, so its presence means the
    // tenant is fully provisioned (see tenant-setup.ts).
    return orgProfile?.[this.tenantIdAttribute]?.S ?? null;
  }

  async updateTenantStatus(
    tenantId: string,
    status: TenantStatus,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<void> {
    await this.setTenantStatus(tenantId, status, requestOptions);
  }

  async deleteTenant(tenantId: string, requestOptions?: OrchestratorRequestOptions): Promise<void> {
    // The caller's signal also stops the retry loop: once the deadline has
    // passed, every further attempt would abort on arrival.
    await pRetry(
      async () => {
        // Precondition only, so a 404 here must not skip the DELETE: a pass that
        // failed partway leaves resources the DELETE still has to collect.
        await this.setTenantStatus(tenantId, 'disabled', {
          allowMissing: true,
          ...requestOptions,
        });

        const { error, response } = await deleteTenantsByTenantId({
          client: this.client,
          path: { tenantId },
          throwOnError: false,
          ...requestOptions,
        });
        // Already deleted answers 204; a 404 means the same.
        if (error && response?.status !== 404) {
          throw new Error(`Failed to delete ${this.id} tenant ${tenantId}`, { cause: error });
        }
      },
      { ...TENANT_DELETE_RETRY, signal: requestOptions?.signal },
    );
  }

  async getTenantStatus(
    tenantId: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<TenantStatusProbe> {
    try {
      const { data, error, response } = await getTenantsByTenantId({
        client: this.client,
        path: { tenantId },
        throwOnError: false,
        ...requestOptions,
      });
      if (error || !data) {
        if (response?.status === 404) return { kind: 'not_found' };
        return {
          kind: 'error',
          cause: error ?? new Error(`Empty tenant response for ${tenantId}`),
        };
      }
      return { kind: 'ok', status: normalizeStatus(data.status) };
    } catch (cause) {
      // With `throwOnError: false` a transport failure, including our own
      // deadline, comes back as an error result with `response` undefined
      // and is handled above. This catch is only for bugs in the SDK or in
      // the response mapping.
      return { kind: 'error', cause };
    }
  }

  // Data-plane bucket operations against the S3 gateway with the console key.
  async createBucket(
    tenantId: string,
    region: S3Region,
    args: CreateBucketArgs,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<void> {
    const ctx = await this.getS3ClientContext(tenantId, region, requestOptions);
    const s3 = createS3Client(ctx);
    await s3CreateBucket(
      s3,
      {
        bucketName: args.bucketName,
        objectLockEnabled: args.lock === true,
      },
      requestOptions,
    );

    // The signal on the retry options stops retrying once the deadline has
    // passed, instead of burning the remaining attempts on instant aborts.
    const retryOpts = { ...BUCKET_CONFIG_RETRY, signal: requestOptions?.signal };
    try {
      if (args.versioning) {
        await pRetry(
          () => setBucketVersioning(s3, args.bucketName, true, requestOptions),
          retryOpts,
        );
      }
      if (args.retention?.enabled) {
        const retention = args.retention;
        await pRetry(
          () =>
            putObjectLockConfiguration(
              s3,
              {
                bucketName: args.bucketName,
                mode: retention.mode,
                duration: retention.duration,
                durationType: retention.durationType,
              },
              requestOptions,
            ),
          retryOpts,
        );
      }
    } catch (err) {
      throw new BucketConfigurationError(args.bucketName, { cause: err });
    }
  }

  async deleteBucket(
    tenantId: string,
    region: S3Region,
    bucketName: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<void> {
    const ctx = await this.getS3ClientContext(tenantId, region, requestOptions);
    const s3 = createS3Client(ctx);
    await s3DeleteBucket(s3, bucketName, requestOptions);
  }

  async listBuckets(
    tenantId: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<BucketSummary[]> {
    // ListBuckets is account-wide at every gateway of the network, so any
    // region's endpoint returns the tenant's buckets in all of them.
    const ctx = await this.getS3ClientContext(tenantId, this.regions[0]!, requestOptions);
    const s3 = createS3Client(ctx);
    const { buckets } = await s3ListBuckets(s3, requestOptions);
    // Versioning and object-lock both cost a call per bucket; neither is
    // returned here (see aurora/fth-orchestrator.ts). getBucket loads both
    // for the one bucket the detail page actually needs them for.
    return buckets.map((b) => ({
      bucketName: b.name,
      region: this.regions[0]!,
      createdAt: b.createdAt,
      isPublic: false,
      // The contract mandates server-side encryption by default.
      encrypted: true,
    }));
  }

  async getBucket(
    tenantId: string,
    region: S3Region,
    bucketName: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<BucketDetails | null> {
    const ctx = await this.getS3ClientContext(tenantId, region, requestOptions);
    const s3 = createS3Client(ctx);
    const { buckets } = await s3ListBuckets(s3, requestOptions);
    const match = buckets.find((b) => b.name === bucketName);
    if (!match) return null;

    const [versioning, lock] = await Promise.all([
      getBucketVersioning(s3, bucketName, requestOptions),
      getBucketObjectLock(s3, bucketName, requestOptions),
    ]);

    return {
      bucketName,
      region,
      createdAt: match.createdAt,
      isPublic: false,
      versioning,
      encrypted: true,
      objectLockEnabled: lock?.objectLockEnabled ?? false,
      ...(lock?.defaultRetention && { defaultRetention: lock.defaultRetention }),
      ...(lock?.retentionDuration != null && { retentionDuration: lock.retentionDuration }),
      ...(lock?.retentionDurationType && { retentionDurationType: lock.retentionDurationType }),
    };
  }

  async issueAccessKey(
    tenantId: string,
    keyOpts: IssueAccessKeyOpts,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<IssuedAccessKey> {
    const permissions = buildPermissions(keyOpts.permissions, keyOpts.granularPermissions);
    const buckets = keyOpts.buckets ?? [];

    console.log(
      `Creating ${this.id} access key "${keyOpts.keyName}" for tenant ${tenantId} with permissions ` +
        `[${permissions.join(', ')}] and bucket scopes [${buckets.join(', ')}]`,
    );

    const { data, error, response } = await postTenantsByTenantIdAccessKeys({
      client: this.client,
      path: { tenantId },
      body: {
        name: keyOpts.keyName,
        // buildPermissions only emits actions from the contract's enum.
        permissions: permissions as CreateAccessKeyRequest['permissions'],
        buckets,
        expiresAt: keyOpts.expiresAt ?? null,
      },
      throwOnError: false,
      ...requestOptions,
    });

    if (error || !data) {
      if (response?.status === 409) {
        throw new AccessKeyAlreadyExistsError({ cause: error });
      }
      if (response?.status === 400 || response?.status === 422) {
        throw new AccessKeyValidationError(
          extractApiMessage(error) ??
            'Invalid access key request. Check the key name and try again.',
          { cause: error },
        );
      }
      throw new Error(
        `Failed to create ${this.id} access key "${keyOpts.keyName}" for tenant ${tenantId}`,
        { cause: error },
      );
    }

    return {
      // The contract has no identifier separate from the accessKeyId.
      id: data.accessKeyId,
      accessKeyId: data.accessKeyId,
      accessKeySecret: data.secretAccessKey,
      createdAt: data.createdAt,
    };
  }

  async findAccessKeyByName(
    tenantId: string,
    keyName: string,
    requestOptions?: OrchestratorRequestOptions,
  ) {
    const { data, error } = await getTenantsByTenantIdAccessKeys({
      client: this.client,
      path: { tenantId },
      throwOnError: false,
      ...requestOptions,
    });
    if (error) {
      throw new Error(`Failed to list ${this.id} access keys for tenant ${tenantId}`, {
        cause: error,
      });
    }
    const match = (data?.items ?? []).find((k) => k.name === keyName);
    if (!match) return undefined;
    return {
      id: match.accessKeyId,
      accessKeyId: match.accessKeyId,
      createdAt: match.createdAt,
    };
  }

  async deleteAccessKey(
    tenantId: string,
    keyId: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<void> {
    const { error, response } = await deleteTenantsByTenantIdAccessKeysByAccessKeyId({
      client: this.client,
      path: { tenantId, accessKeyId: keyId },
      throwOnError: false,
      ...requestOptions,
    });
    if (error) {
      if (response?.status === 404) {
        // The contract 404s only when the tenant is missing (key-level
        // deletes are 204 even when already gone) — either way the key no
        // longer exists, which is what the interface's idempotency needs.
        console.log(
          `${this.id} access key "${keyId}" not found for tenant ${tenantId}, treating as already deleted`,
        );
        return;
      }
      throw new Error(`Failed to delete ${this.id} access key "${keyId}" for tenant ${tenantId}`, {
        cause: error,
      });
    }
  }

  async getTenantUsageMetrics(
    tenantId: string,
    metricsOpts: GetTenantUsageMetricsOptions,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<TenantUsageMetrics> {
    const { data, error } = await getTenantsByTenantIdMetrics({
      client: this.client,
      path: { tenantId },
      query: {
        from: metricsOpts.from,
        to: metricsOpts.to,
        window: mapIntervalToWindow(metricsOpts.interval ?? '1d'),
      },
      throwOnError: false,
      ...requestOptions,
    });
    if (error || !data) {
      throw new Error(`Failed to fetch usage metrics for tenant ${tenantId}`, { cause: error });
    }
    return {
      storage: mapStorageSamples(data),
      egress: data.egress.samples.map((s) => ({
        timestamp: new Date(s.timestamp).toISOString(),
        bytesUsed: s.bytesEgressed,
      })),
      // The contract also returns ingress; the interface doesn't model it.
    };
  }

  async getTenantInfo(
    tenantId: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<TenantInfo> {
    const { data, error } = await getTenantsByTenantId({
      client: this.client,
      path: { tenantId },
      throwOnError: false,
      ...requestOptions,
    });
    if (error || !data) {
      throw new Error(`Failed to fetch tenant info for ${tenantId}`, { cause: error });
    }
    return {
      bucketCount: data.bucketCount ?? 0,
      bucketLimit: data.bucketLimit ?? 0,
      keyCount: data.accessKeyCount ?? 0,
      accessKeyLimit: data.accessKeyLimit ?? 0,
      status: normalizeStatus(data.status),
    };
  }

  async getBucketUsageMetrics(
    tenantId: string,
    bucketName: string,
    metricsOpts: GetTenantUsageMetricsOptions,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<StorageUsageSample[]> {
    // Unlike aurora/fth, no client-side ownership gate is needed: the
    // contract obliges the orchestrator to verify the bucket belongs to the
    // tenant and return 404 otherwise.
    const { data, error, response } = await getTenantsByTenantIdBucketsByBucketNameMetrics({
      client: this.client,
      path: { tenantId, bucketName },
      query: {
        from: metricsOpts.from,
        to: metricsOpts.to,
        window: mapIntervalToWindow(metricsOpts.interval ?? '1d'),
      },
      throwOnError: false,
      ...requestOptions,
    });
    if (error || !data) {
      if (response?.status === 404) {
        throw new BucketNotFoundError(bucketName, { cause: error });
      }
      throw new Error(
        `Failed to fetch usage metrics for bucket "${bucketName}" (tenant ${tenantId})`,
        { cause: error },
      );
    }
    return mapStorageSamples(data);
  }
}

function resolveClient(config: FilOneOrchestratorConfig): Client {
  if ('client' in config.api) return config.api.client;
  const { baseUrl, accessToken: token, fetch } = config.api;
  const client = createClient({
    baseUrl,
    // Resolve the bearer credential lazily so the token isn't captured into a
    // long-lived config object; the SDK sends it as `Authorization: Bearer …`.
    auth: () => token,
    ...(fetch && { fetch }),
  });
  instrumentClient(client, { apiName: `${config.id}-management` });
  return client;
}
