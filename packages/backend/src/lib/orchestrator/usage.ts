// Usage and quota reads over the Management API, mapped to the interface's
// shapes.

import {
  getTenantsByTenantId,
  getTenantsByTenantIdBucketsByBucketNameMetrics,
  getTenantsByTenantIdMetrics,
  type Client,
} from '@filone/orchestrator-client';
import { BucketNotFoundError } from '../errors.ts';
import type {
  GetTenantUsageMetricsOptions,
  OrchestratorRequestOptions,
  StorageUsageSample,
  TenantInfo,
  TenantUsageMetrics,
} from '../service-orchestrator.ts';
import { mapIntervalToWindow, mapStorageSamples, normalizeStatus } from './metrics-mapping.ts';

export async function fetchTenantUsageMetrics(
  client: Client,
  tenantId: string,
  metricsOpts: GetTenantUsageMetricsOptions,
  requestOptions?: OrchestratorRequestOptions,
): Promise<TenantUsageMetrics> {
  const { data, error } = await getTenantsByTenantIdMetrics({
    client,
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

export async function fetchTenantInfo(
  client: Client,
  tenantId: string,
  requestOptions?: OrchestratorRequestOptions,
): Promise<TenantInfo> {
  const { data, error } = await getTenantsByTenantId({
    client,
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

export async function fetchBucketUsageMetrics(
  client: Client,
  { tenantId, bucketName }: { tenantId: string; bucketName: string },
  metricsOpts: GetTenantUsageMetricsOptions,
  requestOptions?: OrchestratorRequestOptions,
): Promise<StorageUsageSample[]> {
  // Unlike aurora/fth, no client-side ownership gate is needed: the
  // contract obliges the orchestrator to verify the bucket belongs to the
  // tenant and return 404 otherwise.
  const { data, error, response } = await getTenantsByTenantIdBucketsByBucketNameMetrics({
    client,
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
