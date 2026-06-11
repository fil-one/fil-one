import {
  createClient,
  createTenant,
  createTenantToken,
  getBucketStorageMetrics,
  getTenant,
  getTenantOperationMetrics,
  getTenantStorageMetrics,
  listTenants,
  setTenantStatus,
  setupS3Component,
  type ModelsSetupStep,
  type ModelOperationMetricsSample,
  type ModelStorageMetricsSample,
  type ModelsTenantStatus,
  type ModelsTenantWithMetricsBackofficeResponse,
} from '@filone/aurora-backoffice-client';
import pRetry from 'p-retry';
import { instrumentClient } from './aurora-api-metrics.js';
import { getAuroraBackofficeSecrets } from '../auth-secrets.js';
import type { TenantStatus } from '../service-orchestrator.js';

export type {
  ModelOperationMetricsSample,
  ModelStorageMetricsSample,
  ModelsTenantStatus,
  ModelsTenantWithMetricsBackofficeResponse,
};

export class DuplicateTokenNameError extends Error {
  constructor() {
    super('An Aurora tenant API token with this name already exists');
    this.name = 'DuplicateTokenNameError';
  }
}

function createBackofficeClient() {
  const baseUrl = process.env.AURORA_BACKOFFICE_URL!;
  const { AURORA_BACKOFFICE_TOKEN: token } = getAuroraBackofficeSecrets();

  const client = createClient({
    baseUrl,
    headers: { 'X-Api-Key': token },
  });
  instrumentClient(client, { apiName: 'aurora-backoffice' });

  return client;
}

export interface CreateAuroraTenantOptions {
  orgId: string;
  displayName: string;
}

export interface CreateAuroraTenantResult {
  auroraTenantId: string;
}

export async function createAuroraTenant({
  orgId,
  displayName,
}: CreateAuroraTenantOptions): Promise<CreateAuroraTenantResult> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const regionId = process.env.AURORA_REGION_ID!;
  const client = createBackofficeClient();

  const { data, error, response } = await createTenant({
    client,
    path: { partnerId },
    body: {
      name: orgId,
      displayName,
      regionId,
    },
    throwOnError: false,
  });

  if (error) {
    const status = response?.status;
    if (status === 409) {
      console.log(`Aurora tenant already exists for org ${orgId}, looking up existing tenant`);
      try {
        return await findAuroraTenantByOrgId({ client, partnerId, orgId });
      } catch (cause) {
        throw new Error(`Aurora tenant already exists for org ${orgId} but lookup failed`, {
          cause,
        });
      }
    }
    console.error('Failed to create Aurora tenant:', error);
    throw new Error(`Aurora tenant creation failed for org ${orgId}`, {
      cause: error,
    });
  }

  const auroraTenantId = data?.id;
  if (!auroraTenantId) {
    throw new Error(`Aurora API did not return a tenant id for org ${orgId}`);
  }

  console.log(`Aurora tenant created for org ${orgId}:`, JSON.stringify(data));
  return { auroraTenantId };
}

async function findAuroraTenantByOrgId({
  client,
  partnerId,
  orgId,
}: {
  client: ReturnType<typeof createClient>;
  partnerId: string;
  orgId: string;
}): Promise<CreateAuroraTenantResult> {
  const { data, error } = await listTenants({
    client,
    path: { partnerId },
    // TODO: paginate through all pages instead of assuming ≤1000 tenants
    query: { pageSize: 1000 },
    throwOnError: false,
  });

  if (error) {
    throw new Error(`Failed to list Aurora tenants for partner ${partnerId}`, {
      cause: error,
    });
  }

  const tenant = data?.items?.find((t) => t.name === orgId);
  if (!tenant?.id) {
    throw new Error(`Aurora tenant not found for org ${orgId}`);
  }

  console.log(`Found Aurora tenant for org ${orgId}:`, JSON.stringify(tenant));
  return { auroraTenantId: tenant.id };
}

export interface SetupAuroraTenantOptions {
  tenantId: string;
}

export interface SetupAuroraTenantResult {
  lastSetupStep: ModelsSetupStep;
}

export async function setupAuroraTenant({
  tenantId,
}: SetupAuroraTenantOptions): Promise<SetupAuroraTenantResult> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error } = await setupS3Component({
    client,
    path: { partnerId, tenantId },
    throwOnError: false,
    // Aurora API returns content-type: text/plain, force JSON parsing
    parseAs: 'json',
  });

  if (error) {
    console.error('Failed to setup Aurora tenant:', error);
    throw new Error(`Aurora tenant setup failed for tenant ${tenantId}`, {
      cause: error,
    });
  }

  if (!data) {
    throw new Error(`Aurora API did not return setup data for tenant ${tenantId}`);
  }

  const { lastSetupStep } = data;
  if (!lastSetupStep) {
    throw new Error(`Aurora API did not return lastSetupStep for tenant ${tenantId}`);
  }

  console.log(
    `Aurora tenant ${tenantId} S3 setup response:`,
    JSON.stringify(data),
    `=> lastSetupStep=${lastSetupStep}`,
  );
  return { lastSetupStep };
}

export interface CreateAuroraTenantApiKeyOptions {
  tenantId: string;
  orgId: string;
}

export interface CreateAuroraTenantApiKeyResult {
  token: string;
  tokenId: string;
}

export async function createAuroraTenantApiKey({
  tenantId,
  orgId,
}: CreateAuroraTenantApiKeyOptions): Promise<CreateAuroraTenantApiKeyResult> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error, response } = await createTenantToken({
    client,
    path: { partnerId, tenantId },
    body: { name: `filone-${orgId}` },
    throwOnError: false,
  });

  if (error) {
    if (response?.status === 409) {
      throw new DuplicateTokenNameError();
    }
    console.error('Failed to create Aurora API key:', error);
    throw new Error(`Aurora API key creation failed for org ${orgId}`, {
      cause: error,
    });
  }

  const apiToken = data?.token;
  if (!apiToken) {
    throw new Error(
      `Aurora API did not return a token for org ${orgId}. Response fields: ${Object.keys(data).join(', ')}`,
    );
  }

  const tokenId = data.id;
  if (!tokenId) {
    throw new Error(
      `Aurora API did not return a token ID for org ${orgId}. Response fields: ${Object.keys(data).join(', ')}`,
    );
  }

  console.log(`Aurora API key created for org ${orgId}: tokenId=${tokenId}`);
  return { token: apiToken, tokenId };
}

// Aurora's metrics endpoints reject queries whose (to − from) span exceeds
// ~40 days. For longer spans (e.g. grace-period subscriptions whose
// currentPeriodStart can be ~60 days old) we split the request into ≤40-day
// sub-ranges, fetch them in parallel, and merge the samples — dedupe by
// timestamp absorbs any overlap at range boundaries.
const MAX_AURORA_QUERY_RANGE_DAYS = 40;
const MAX_AURORA_QUERY_RANGE_MS = MAX_AURORA_QUERY_RANGE_DAYS * 24 * 60 * 60 * 1000;

function splitTimeRange(fromIso: string, toIso: string): Array<{ from: string; to: string }> {
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return [{ from: fromIso, to: toIso }];
  }
  if (toMs - fromMs <= MAX_AURORA_QUERY_RANGE_MS) {
    return [{ from: fromIso, to: toIso }];
  }
  const ranges: Array<{ from: string; to: string }> = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const next = Math.min(cursor + MAX_AURORA_QUERY_RANGE_MS, toMs);
    ranges.push({ from: new Date(cursor).toISOString(), to: new Date(next).toISOString() });
    cursor = next;
  }
  return ranges;
}

function dedupeByTimestamp<T extends { timestamp?: string }>(samples: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const sample of samples) {
    const key = sample.timestamp;
    if (key === undefined) {
      out.push(sample);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sample);
  }
  return out;
}

export interface GetStorageSamplesOptions {
  tenantId: string;
  from: string;
  to: string;
  window?: string;
}

async function fetchStorageSamplesRange({
  tenantId,
  from,
  to,
  window,
}: {
  tenantId: string;
  from: string;
  to: string;
  window: string;
}): Promise<ModelStorageMetricsSample[]> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error } = await getTenantStorageMetrics({
    client,
    path: { partnerId, tenantId },
    query: { from, to, window },
    throwOnError: false,
  });

  if (error) {
    throw new Error(
      `Aurora storage API failed for tenant ${tenantId} (from=${from} to=${to} window=${window})`,
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
}: GetStorageSamplesOptions): Promise<ModelStorageMetricsSample[]> {
  const ranges = splitTimeRange(from, to);
  if (ranges.length === 1) {
    return fetchStorageSamplesRange({ tenantId, from, to, window });
  }

  console.log('[aurora-client] Splitting storage query into ranges', {
    tenantId,
    ranges: ranges.length,
    from,
    to,
    window,
  });
  const results = await Promise.all(
    ranges.map((r) => fetchStorageSamplesRange({ tenantId, from: r.from, to: r.to, window })),
  );
  return dedupeByTimestamp(results.flat());
}

export interface GetBucketStorageSamplesOptions {
  bucketName: string;
  from: string;
  to: string;
  window?: string;
}

export async function getBucketStorageSamples({
  bucketName,
  from,
  to,
  window = '1h',
}: GetBucketStorageSamplesOptions): Promise<ModelStorageMetricsSample[]> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error } = await getBucketStorageMetrics({
    client,
    path: { partnerId, bucketName },
    query: { from, to, window },
    throwOnError: false,
  });

  if (error) {
    throw new Error(`Aurora bucket storage API failed for bucket ${bucketName}`, {
      cause: error,
    });
  }

  return data?.samples ?? [];
}

export interface GetOperationsSamplesOptions {
  tenantId: string;
  from: string;
  to: string;
  window?: string;
}

async function fetchOperationsSamplesRange({
  tenantId,
  from,
  to,
  window,
}: {
  tenantId: string;
  from: string;
  to: string;
  window: string;
}): Promise<ModelOperationMetricsSample[]> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error } = await getTenantOperationMetrics({
    client,
    path: { partnerId, tenantId },
    query: { from, to, window },
    throwOnError: false,
  });

  if (error) {
    throw new Error(
      `Aurora operations API failed for tenant ${tenantId} (from=${from} to=${to} window=${window})`,
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
}: GetOperationsSamplesOptions): Promise<ModelOperationMetricsSample[]> {
  const ranges = splitTimeRange(from, to);
  if (ranges.length === 1) {
    return fetchOperationsSamplesRange({ tenantId, from, to, window });
  }

  console.log('[aurora-client] Splitting operations query into ranges', {
    tenantId,
    ranges: ranges.length,
    from,
    to,
    window,
  });
  const results = await Promise.all(
    ranges.map((r) => fetchOperationsSamplesRange({ tenantId, from: r.from, to: r.to, window })),
  );
  return dedupeByTimestamp(results.flat());
}

export async function getTenantInfo({
  tenantId,
}: {
  tenantId: string;
}): Promise<ModelsTenantWithMetricsBackofficeResponse> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error } = await getTenant({
    client,
    path: { partnerId, tenantId },
    throwOnError: false,
  });

  if (error) {
    throw new Error(`Aurora tenant API failed for tenant ${tenantId}`, {
      cause: error,
    });
  }

  if (!data) {
    throw new Error(`Aurora API did not return tenant data for tenant ${tenantId}`);
  }

  return data;
}

export type TenantStatusResult =
  | { kind: 'ok'; status: ModelsTenantStatus | undefined }
  | { kind: 'not_found' }
  | { kind: 'error'; cause: unknown };

// Variant of getTenantInfo for drift-check style read-only probes: never throws,
// distinguishes tenant-not-found (404) from transport/server errors so callers
// can classify those cases separately instead of bucketing them together.
export async function getTenantStatus({
  tenantId,
}: {
  tenantId: string;
}): Promise<TenantStatusResult> {
  try {
    const partnerId = process.env.AURORA_PARTNER_ID!;
    const client = createBackofficeClient();

    const { data, error, response } = await getTenant({
      client,
      path: { partnerId, tenantId },
      throwOnError: false,
    });

    if (response?.status === 404) return { kind: 'not_found' };
    if (error) return { kind: 'error', cause: error };
    return { kind: 'ok', status: data?.status };
  } catch (cause) {
    return { kind: 'error', cause };
  }
}

// Maps the orchestrator-agnostic TenantStatus to Aurora's generated enum.
// Homed here (not in region-helpers.ts) to avoid an import cycle: the registry
// imports the orchestrator, so the orchestrator can't import back from
// region-helpers.ts. aurora-backoffice.ts imports no registry/orchestrator.
const TENANT_STATUS_TO_MODELS: Record<TenantStatus, ModelsTenantStatus> = {
  active: 'ACTIVE',
  'write-locked': 'WRITE_LOCKED',
  disabled: 'DISABLED',
};

export function mapToModelsTenantStatus(status: TenantStatus): ModelsTenantStatus {
  const modelsStatus = TENANT_STATUS_TO_MODELS[status];
  if (!modelsStatus) {
    throw new Error(`Unknown tenant status: ${String(status)}`);
  }
  return modelsStatus;
}

// Reverse of TENANT_STATUS_TO_MODELS. Returns undefined for Aurora's never-used
// `LOCKED` value, which has no orchestrator-agnostic equivalent we model.
const MODELS_TO_TENANT_STATUS: Record<ModelsTenantStatus, TenantStatus | undefined> = {
  ACTIVE: 'active',
  WRITE_LOCKED: 'write-locked',
  DISABLED: 'disabled',
  LOCKED: undefined,
};

export function mapFromModelsTenantStatus(status: ModelsTenantStatus): TenantStatus | undefined {
  return MODELS_TO_TENANT_STATUS[status];
}

export async function updateTenantStatus({
  tenantId,
  status,
}: {
  tenantId: string;
  status: ModelsTenantStatus;
}): Promise<void> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  await pRetry(
    async () => {
      const { error } = await setTenantStatus({
        client,
        path: { partnerId, tenantId },
        body: { status },
        throwOnError: false,
      });

      if (error) {
        throw new Error(`Aurora status update failed for tenant ${tenantId}`, {
          cause: error,
        });
      }
    },
    { retries: 3 },
  );
}
