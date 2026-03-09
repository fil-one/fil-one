import {
  createClient,
  getPartnersByPartnerIdTenants,
  postPartnersByPartnerIdTenants,
  postPartnersByPartnerIdTenantsByTenantIdSetup,
} from '@hyperspace/aurora-backoffice-client';
import { getAuroraBackofficeSecrets } from './auth-secrets.js';

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
  const baseUrl = process.env.AURORA_BACKOFFICE_URL!;
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const regionId = process.env.AURORA_REGION_ID!;
  const { AURORA_BACKOFFICE_TOKEN: token } = getAuroraBackofficeSecrets();

  const client = createClient({
    baseUrl,
    headers: {
      'X-Api-Key': token,
    },
  });

  const { data, error, response } = await postPartnersByPartnerIdTenants({
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
      console.log(
        `Aurora tenant already exists for org ${orgId}, looking up existing tenant`,
      );
      try {
        return await findAuroraTenantByOrgId({ client, partnerId, orgId });
      } catch (cause) {
        throw new Error(
          `Aurora tenant already exists for org ${orgId} but lookup failed`,
          {
            cause,
          },
        );
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
  const { data, error } = await getPartnersByPartnerIdTenants({
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

  const tenant = data?.tenants?.find((t) => t.name === orgId);
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
  lastSetupStep: string;
}

export async function setupAuroraTenant({
  tenantId,
}: SetupAuroraTenantOptions): Promise<SetupAuroraTenantResult> {
  const baseUrl = process.env.AURORA_BACKOFFICE_URL!;
  const partnerId = process.env.AURORA_PARTNER_ID!;
  const { AURORA_BACKOFFICE_TOKEN: token } = getAuroraBackofficeSecrets();

  const client = createClient({
    baseUrl,
    headers: {
      'X-Api-Key': token,
    },
  });

  const { data, error } = await postPartnersByPartnerIdTenantsByTenantIdSetup({
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
    throw new Error(
      `Aurora API did not return setup data for tenant ${tenantId}`,
    );
  }

  console.log(
    `Aurora tenant ${tenantId} setup response:`,
    JSON.stringify(data),
  );
  return { id: data.id!, lastSetupStep: data.lastSetupStep! };
}
