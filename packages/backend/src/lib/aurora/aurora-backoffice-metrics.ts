import {
  getBucketStorageMetrics,
  getTenantOperationMetrics,
  getTenantStorageMetrics,
  type ModelOperationMetricsSample,
  type ModelStorageMetricsSample,
} from '@filone/aurora-backoffice-client';
import { createBackofficeClient } from './aurora-backoffice.ts';
import { dedupeByTimestamp, splitTimeRange } from '../time-range.ts';

export type { ModelOperationMetricsSample, ModelStorageMetricsSample };

// Aurora's metrics endpoints reject queries whose (to − from) span exceeds
// ~40 days. For longer spans (e.g. grace-period subscriptions whose
// currentPeriodStart can be ~60 days old) we split the request into ≤40-day
// sub-ranges, fetch them in parallel, and merge the samples — dedupe by
// timestamp absorbs any overlap at range boundaries.
const MAX_AURORA_QUERY_RANGE_DAYS = 40;
const MAX_AURORA_QUERY_RANGE_MS = MAX_AURORA_QUERY_RANGE_DAYS * 24 * 60 * 60 * 1000;

export interface GetStorageSamplesOptions {
  tenantId: string;
  from: string;
  to: string;
  window?: string;
  /** Aborts every range request. The caller owns the deadline. */
  signal?: AbortSignal;
}

async function fetchStorageSamplesRange({
  tenantId,
  from,
  to,
  window,
  signal,
}: {
  tenantId: string;
  from: string;
  to: string;
  window: string;
  signal?: AbortSignal;
}): Promise<ModelStorageMetricsSample[]> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error, response } = await getTenantStorageMetrics({
    client,
    signal,
    path: { partnerId, tenantId },
    query: { from, to, window },
    throwOnError: false,
  });

  if (error) {
    throw new Error(
      `Aurora storage API failed for tenant ${tenantId} (status=${response?.status ?? 'unknown'} from=${from} to=${to} window=${window})`,
      { cause: error },
    );
  }

  return data?.samples ?? [];
}

export async function getStorageSamples({
  tenantId,
  from,
  to,
  window = '1h',
  signal,
}: GetStorageSamplesOptions): Promise<ModelStorageMetricsSample[]> {
  const ranges = splitTimeRange(from, to, MAX_AURORA_QUERY_RANGE_MS);
  if (ranges.length === 1) {
    return fetchStorageSamplesRange({ tenantId, from, to, window, signal });
  }

  console.log('[aurora-client] Splitting storage query into ranges', {
    tenantId,
    ranges: ranges.length,
    from,
    to,
    window,
  });
  const results = await Promise.all(
    ranges.map((r) =>
      fetchStorageSamplesRange({ tenantId, from: r.from, to: r.to, window, signal }),
    ),
  );
  return dedupeByTimestamp(results.flat());
}

export interface GetBucketStorageSamplesOptions {
  bucketName: string;
  from: string;
  to: string;
  window?: string;
  /** Aborts the backoffice request. The caller owns the deadline. */
  signal?: AbortSignal;
}

export async function getBucketStorageSamples({
  bucketName,
  from,
  to,
  window = '1h',
  signal,
}: GetBucketStorageSamplesOptions): Promise<ModelStorageMetricsSample[]> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error, response } = await getBucketStorageMetrics({
    client,
    signal,
    path: { partnerId, bucketName },
    query: { from, to, window },
    throwOnError: false,
  });

  if (error) {
    throw new Error(
      `Aurora bucket storage API failed for bucket ${bucketName} (status=${response?.status ?? 'unknown'})`,
      { cause: error },
    );
  }

  return data?.samples ?? [];
}

export interface GetOperationsSamplesOptions {
  tenantId: string;
  from: string;
  to: string;
  window?: string;
  /** Aborts every range request. The caller owns the deadline. */
  signal?: AbortSignal;
}

async function fetchOperationsSamplesRange({
  tenantId,
  from,
  to,
  window,
  signal,
}: {
  tenantId: string;
  from: string;
  to: string;
  window: string;
  signal?: AbortSignal;
}): Promise<ModelOperationMetricsSample[]> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error, response } = await getTenantOperationMetrics({
    client,
    signal,
    path: { partnerId, tenantId },
    query: { from, to, window },
    throwOnError: false,
  });

  if (error) {
    throw new Error(
      `Aurora operations API failed for tenant ${tenantId} (status=${response?.status ?? 'unknown'} from=${from} to=${to} window=${window})`,
      { cause: error },
    );
  }

  return data?.series?.[0]?.samples ?? [];
}

export async function getOperationsSamples({
  tenantId,
  from,
  to,
  window = '24h',
  signal,
}: GetOperationsSamplesOptions): Promise<ModelOperationMetricsSample[]> {
  const ranges = splitTimeRange(from, to, MAX_AURORA_QUERY_RANGE_MS);
  if (ranges.length === 1) {
    return fetchOperationsSamplesRange({ tenantId, from, to, window, signal });
  }

  console.log('[aurora-client] Splitting operations query into ranges', {
    tenantId,
    ranges: ranges.length,
    from,
    to,
    window,
  });
  const results = await Promise.all(
    ranges.map((r) =>
      fetchOperationsSamplesRange({ tenantId, from: r.from, to: r.to, window, signal }),
    ),
  );
  return dedupeByTimestamp(results.flat());
}
