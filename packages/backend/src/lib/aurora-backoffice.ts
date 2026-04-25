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
  setupTenant,
  type ModelsComponentsStatus,
  type ModelsSetupStep,
  type ModelOperationMetricsSample,
  type ModelStorageMetricsSample,
  type ModelsTenantStatus,
  type ModelsTenantWithMetricsManagementResponse,
} from '@filone/aurora-backoffice-client';
import pRetry from 'p-retry';
import { instrumentClient } from './aurora-api-metrics.js';
import { getAuroraBackofficeSecrets } from './auth-secrets.js';

export type {
  ModelOperationMetricsSample,
  ModelStorageMetricsSample,
  ModelsTenantStatus,
  ModelsTenantWithMetricsManagementResponse,
};

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
  id: string;
  lastSetupStep: ModelsSetupStep;
}

export async function setupAuroraTenant({
  tenantId,
}: SetupAuroraTenantOptions): Promise<SetupAuroraTenantResult> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error } = await setupTenant({
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

  const lastSetupStep = deriveOverallSetupStep(data.components);
  console.log(
    `Aurora tenant ${tenantId} setup response:`,
    JSON.stringify(data),
    `=> overall lastSetupStep=${lastSetupStep}`,
  );
  return { id: data.id!, lastSetupStep };
}

function deriveOverallSetupStep(components: ModelsComponentsStatus | undefined): ModelsSetupStep {
  if (!components) return 'NOT_STARTED';
  // Only check auth & s3 — compute is not set up yet
  const steps = [components.auth?.lastSetupStep, components.s3?.lastSetupStep].filter(Boolean);
  if (steps.length === 0) return 'NOT_STARTED';
  const nonFinished = steps.find((s) => s !== 'FINISHED');
  return nonFinished ?? 'FINISHED';
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

  const { data, error } = await createTenantToken({
    client,
    path: { partnerId, tenantId },
    body: { name: `filone-${orgId}` },
    throwOnError: false,
  });

  if (error) {
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

export interface GetStorageSamplesOptions {
  tenantId: string;
  from: string;
  to: string;
  window?: string;
}

export async function getStorageSamples({
  tenantId,
  from,
  to,
  window = '1h',
}: GetStorageSamplesOptions): Promise<ModelStorageMetricsSample[]> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error } = await getTenantStorageMetrics({
    client,
    path: { partnerId, tenantId },
    query: { from, to, window },
    throwOnError: false,
  });

  if (error) {
    throw new Error(`Aurora storage API failed for tenant ${tenantId}`, {
      cause: error,
    });
  }

  return data?.samples ?? [];
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

export async function getOperationsSamples({
  tenantId,
  from,
  to,
  window = '24h',
}: GetOperationsSamplesOptions): Promise<ModelOperationMetricsSample[]> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error } = await getTenantOperationMetrics({
    client,
    path: { partnerId, tenantId },
    query: { from, to, window },
    throwOnError: false,
  });

  if (error) {
    throw new Error(`Aurora operations API failed for tenant ${tenantId}`, {
      cause: error,
    });
  }

  return data?.series?.[0]?.samples ?? [];
}

export async function getTenantInfo({
  tenantId,
}: {
  tenantId: string;
}): Promise<ModelsTenantWithMetricsManagementResponse> {
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
