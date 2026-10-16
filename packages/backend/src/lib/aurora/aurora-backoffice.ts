import {
  createClient,
  createTenantV2,
  deleteTenant,
  createTenantTokenV2,
  getTenantV2,
  listTenantsV2,
  setTenantStatus,
  setupS3Component,
  type ModelsSetupStep,
  type ModelsTenantStatus,
  type RbacPortalPermission,
  type ModelsTenantWithMetricsBackofficeResponseV2,
} from '@filone/aurora-backoffice-client';
import { instrumentClient } from './aurora-api-metrics.ts';
import { getAuroraBackofficeSecrets } from '../auth-secrets.ts';
import type { TenantStatus } from '@filone/shared';

export type { ModelsTenantStatus, ModelsTenantWithMetricsBackofficeResponseV2 };

export class DuplicateTokenNameError extends Error {
  constructor() {
    super('An Aurora tenant API token with this name already exists');
    this.name = 'DuplicateTokenNameError';
  }
}

export function createBackofficeClient() {
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
  /** Aborts the backoffice requests, including the 409 lookup. The caller owns the deadline. */
  signal?: AbortSignal;
}

export interface CreateAuroraTenantResult {
  auroraTenantId: string;
}

export async function createAuroraTenant({
  orgId,
  displayName,
  signal,
}: CreateAuroraTenantOptions): Promise<CreateAuroraTenantResult> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const regionId = process.env.AURORA_REGION_ID!;
  const client = createBackofficeClient();

  const { data, error, response } = await createTenantV2({
    client,
    signal,
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
        return await findAuroraTenantByOrgId({ client, partnerId, orgId, signal });
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
  signal,
}: {
  client: ReturnType<typeof createClient>;
  partnerId: string;
  orgId: string;
  signal?: AbortSignal;
}): Promise<CreateAuroraTenantResult> {
  const { data, error } = await listTenantsV2({
    client,
    signal,
    path: { partnerId },
    // Aurora caps pageSize at 20; orgName matches the tenant name exactly.
    query: { orgName: orgId },
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
  /** Aborts the backoffice request. The caller owns the deadline. */
  signal?: AbortSignal;
}

export interface SetupAuroraTenantResult {
  lastSetupStep: ModelsSetupStep;
}

export async function setupAuroraTenant({
  tenantId,
  signal,
}: SetupAuroraTenantOptions): Promise<SetupAuroraTenantResult> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error } = await setupS3Component({
    client,
    signal,
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

// The portal calls the console makes with the tenant token: bucket and S3
// access-key management. Nothing else.
const TENANT_TOKEN_PERMISSIONS: RbacPortalPermission[] = [
  'read:s3:access_keys',
  'create:s3:access_keys',
  'delete:s3:access_keys',
  'read:s3:buckets',
  'create:s3:buckets',
  'update:s3:buckets',
  'delete:s3:buckets',
];

export interface CreateAuroraTenantApiKeyOptions {
  tenantId: string;
  orgId: string;
  /** Aborts the backoffice request. The caller owns the deadline. */
  signal?: AbortSignal;
}

export interface CreateAuroraTenantApiKeyResult {
  token: string;
  tokenId: string;
}

export async function createAuroraTenantApiKey({
  tenantId,
  orgId,
  signal,
}: CreateAuroraTenantApiKeyOptions): Promise<CreateAuroraTenantApiKeyResult> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error, response } = await createTenantTokenV2({
    client,
    signal,
    path: { partnerId, tenantId },
    body: { name: `filone-${orgId}`, permissions: TENANT_TOKEN_PERMISSIONS },
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

export async function getTenantInfo({
  tenantId,
  signal,
}: {
  tenantId: string;
  /** Aborts the backoffice request. The caller owns the deadline. */
  signal?: AbortSignal;
}): Promise<ModelsTenantWithMetricsBackofficeResponseV2> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { data, error } = await getTenantV2({
    client,
    signal,
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
  signal,
}: {
  tenantId: string;
  /** Aborts the backoffice request. The caller owns the deadline. */
  signal?: AbortSignal;
}): Promise<TenantStatusResult> {
  try {
    const partnerId = process.env.AURORA_PARTNER_ID!;
    const client = createBackofficeClient();

    const { data, error, response } = await getTenantV2({
      client,
      signal,
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

export function mapFromModelsTenantStatus(status?: ModelsTenantStatus): TenantStatus | undefined {
  return status ? MODELS_TO_TENANT_STATUS[status] : undefined;
}

export async function updateTenantStatus({
  tenantId,
  status,
  allowMissing,
  signal,
}: {
  tenantId: string;
  status: ModelsTenantStatus;
  /** Treat a 404 or 410 as success — for callers whose goal is the tenant being gone. */
  allowMissing?: boolean;
  /** Aborts the backoffice request. The caller owns the deadline. */
  signal?: AbortSignal;
}): Promise<void> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { error, response } = await setTenantStatus({
    client,
    signal,
    path: { partnerId, tenantId },
    body: { status },
    throwOnError: false,
  });

  if (error) {
    // 410: Aurora has started deleting the tenant, which also leaves it gone.
    if (allowMissing && (response?.status === 404 || response?.status === 410)) return;
    throw new Error(`Aurora status update failed for tenant ${tenantId}`, {
      cause: error,
    });
  }
}

// Aurora tears the tenant down asynchronously and the call is idempotent:
// repeating it resumes an interrupted teardown. A 404 means the tenant is
// already gone, which is the goal.
export async function deleteAuroraTenant({
  tenantId,
  signal,
}: {
  tenantId: string;
  /** Aborts the backoffice request. The caller owns the deadline. */
  signal?: AbortSignal;
}): Promise<void> {
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const client = createBackofficeClient();

  const { error, response } = await deleteTenant({
    client,
    signal,
    path: { partnerId, tenantId },
    throwOnError: false,
  });

  if (error) {
    if (response?.status === 404) return;
    throw new Error(`Aurora tenant deletion failed for tenant ${tenantId}`, {
      cause: error,
    });
  }
}
