import { vi } from 'vitest';
import type {
  BucketDetails,
  EgressUsageSample,
  StorageUsageSample,
  TenantInfo,
} from '../lib/service-orchestrator.ts';
import { S3Region, type TenantStatus } from '@filone/shared';
import type { AccessModel } from '@filone/shared';

export interface FakeOrchestrator {
  id: string;
  region: string;
  accessModel: AccessModel;
  isTenantReady: ReturnType<typeof vi.fn>;
  getTenantStatus: ReturnType<typeof vi.fn>;
  updateTenantStatus: ReturnType<typeof vi.fn>;
  getTenantUsageMetrics: ReturnType<typeof vi.fn>;
  getTenantInfo: ReturnType<typeof vi.fn>;
  getBucketUsageMetrics: ReturnType<typeof vi.fn>;
  getBucket: ReturnType<typeof vi.fn>;
  listBuckets: ReturnType<typeof vi.fn>;
}

export interface FakeOrchestratorOpts {
  /** When false, `isTenantReady` resolves `null` (region not provisioned). */
  ready?: boolean;
  /** Live status returned by `getTenantStatus` (status-sync paths). */
  status?: TenantStatus;
  /** Region reported by the orchestrator. Defaults to `eu-west-1`. */
  region?: S3Region;
  /** Access model reported by the orchestrator. Defaults to `scoped-keys`. */
  accessModel?: AccessModel;
  /** Storage series returned by `getTenantUsageMetrics`. Defaults to empty. */
  storage?: StorageUsageSample[];
  /** Egress series returned by `getTenantUsageMetrics`. Defaults to empty. */
  egress?: EgressUsageSample[];
  /** Quota/status snapshot returned by `getTenantInfo`. Missing fields default. */
  info?: Partial<TenantInfo>;
  /** Storage series (or an Error to reject with) for `getBucketUsageMetrics`. */
  bucketMetrics?: StorageUsageSample[] | Error;
  /** Bucket resolved by `getBucket`; `null` = not found. Defaults to `null`. */
  bucket?: BucketDetails | null;
  /** Bucket names returned by `listBuckets`. Defaults to none. */
  buckets?: string[];
  /** When true, `getTenantUsageMetrics`, `getTenantInfo` and `listBuckets` reject. */
  failUsage?: boolean;
}

/**
 * Builds a fake ServiceOrchestrator covering the methods exercised by the
 * tenant status-sync, usage-dashboard, and per-bucket-analytics code paths. The
 * tenant id is derived from the orgId carried in the {@link fakeOrgProfile} item
 * (see {@link tenantFor}) so per-org assertions stay unambiguous; pass
 * `ready: false` to simulate a region where the tenant is not provisioned.
 */
export function fakeOrchestrator(id: string, opts: FakeOrchestratorOpts = {}): FakeOrchestrator {
  const { ready = true, status = 'active', region = S3Region.EuWest1, failUsage = false } = opts;
  const regionDown = () => vi.fn().mockRejectedValue(new Error('region down'));

  return {
    id,
    region,
    accessModel: opts.accessModel ?? 'scoped-keys',
    isTenantReady: vi.fn((orgProfile?: { pk?: { S?: string } }) => {
      const orgId = orgProfile?.pk?.S?.replace('ORG#', '');
      return ready && orgId ? tenantFor(id, orgId) : null;
    }),
    getTenantStatus: vi.fn(async () => ({ kind: 'ok', status })),
    updateTenantStatus: vi.fn().mockResolvedValue(undefined),
    getTenantUsageMetrics: failUsage
      ? regionDown()
      : vi.fn().mockResolvedValue({ storage: opts.storage ?? [], egress: opts.egress ?? [] }),
    getTenantInfo: failUsage ? regionDown() : vi.fn().mockResolvedValue(buildTenantInfo(opts.info)),
    getBucketUsageMetrics: fakeBucketMetrics(opts.bucketMetrics),
    getBucket: vi.fn().mockResolvedValue(opts.bucket ?? null),
    listBuckets: failUsage
      ? regionDown()
      : vi.fn().mockResolvedValue((opts.buckets ?? []).map((bucketName) => ({ bucketName }))),
  };
}

function buildTenantInfo(info: Partial<TenantInfo> = {}): TenantInfo {
  return {
    bucketCount: info.bucketCount ?? 0,
    bucketLimit: info.bucketLimit ?? 100,
    keyCount: info.keyCount ?? 0,
    accessKeyLimit: info.accessKeyLimit ?? 300,
    status: info.status,
  };
}

function fakeBucketMetrics(bucketMetrics: StorageUsageSample[] | Error = []) {
  return bucketMetrics instanceof Error
    ? vi.fn().mockRejectedValue(bucketMetrics)
    : vi.fn().mockResolvedValue(bucketMetrics);
}

/** The PROFILE item a mocked `getOrgProfile` should resolve for the given org. */
export function fakeOrgProfile(orgId: string) {
  return { pk: { S: `ORG#${orgId}` } };
}

/** The tenant id a {@link fakeOrchestrator} resolves for the given org. */
export function tenantFor(orchestratorId: string, orgId: string): string {
  return `${orchestratorId}:${orgId}`;
}
