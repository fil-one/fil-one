import type { TenantStatus } from '@filone/shared';
import type { OrchestratorRequestOptions } from './service-orchestrator.ts';

/**
 * A single point in a tenant's storage-usage time series.
 */
export interface StorageUsageSample {
  /** Canonical ISO-8601 UTC timestamp (e.g. `2026-01-01T10:00:00.000Z`). */
  timestamp: string;
  bytesUsed: number;
  /** 0 when the orchestrator's source has no object-count series. */
  objectCount: number;
}

/** A single point in a tenant's egress time series. `timestamp` is canonical ISO-8601 UTC (see {@link StorageUsageSample}). */
export interface EgressUsageSample {
  /** Canonical ISO-8601 UTC timestamp (e.g. `2026-01-01T10:00:00.000Z`). */
  timestamp: string;
  bytesUsed: number;
}

/** Normalized, orchestrator-agnostic usage/egress time series for a tenant. */
export interface TenantUsageMetrics {
  storage: StorageUsageSample[];
  egress: EgressUsageSample[];
}

export interface GetTenantUsageMetricsOptions {
  /** Inclusive start timestamp, RFC3339 UTC. */
  from: string;
  /** Exclusive end timestamp, RFC3339 UTC. */
  to: string;
  /** Sampling window applied to BOTH series. Defaults to '1d'. */
  interval?: string;
}

/**
 * Normalized, orchestrator-agnostic tenant quota and status snapshot.
 *
 * `keyCount` / `accessKeyLimit` are raw values that include the per-tenant
 * system key (and its reserved slot): `filone-console` on Aurora,
 * `filone-console-v2` on FTH. Callers that surface user-managed keys should
 * subtract one per tenant.
 */
export interface TenantInfo {
  bucketCount: number;
  bucketLimit: number;
  keyCount: number;
  accessKeyLimit: number;
  status?: TenantStatus;
}

/** Read-only usage and quota figures. */
export interface UsageOrchestrator {
  /**
   * Returns the tenant's storage and egress usage as normalized time series
   * over `[from, to)`. Read-only — does not mutate tenant state. Backs both the
   * usage-reporting worker and read-path handlers (e.g. get-activity).
   */
  getTenantUsageMetrics(
    tenantId: string,
    metricsOpts: GetTenantUsageMetricsOptions,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<TenantUsageMetrics>;

  /**
   * Returns the tenant's quota and status snapshot (bucket/key counts and
   * limits, lifecycle status). Read-only. Backs the usage dashboard.
   */
  getTenantInfo(tenantId: string, requestOptions?: OrchestratorRequestOptions): Promise<TenantInfo>;

  /**
   * Returns a single bucket's storage usage as a normalized time series over
   * `[from, to)`. Read-only. Backs per-bucket analytics. The ownership check is
   * performed here (tenant-scoped): throws {@link BucketNotFoundError} when the
   * bucket is not found or not owned by the tenant. Returns an empty array when
   * the bucket is owned but has no storage series yet.
   */
  getBucketUsageMetrics(
    tenantId: string,
    bucketName: string,
    metricsOpts: GetTenantUsageMetricsOptions,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<StorageUsageSample[]>;
}
