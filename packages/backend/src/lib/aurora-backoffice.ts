import {
  createClient,
  postPartnersByPartnerIdTenants,
} from "@hyperspace/aurora-backoffice-client";
import { getAuroraBackofficeSecrets } from "./auth-secrets.js";

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
      "X-Api-Key": token,
    },
  });

  const { data, error } = await postPartnersByPartnerIdTenants({
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
    console.error("Failed to create Aurora tenant:", error);
    throw new Error(`Aurora tenant creation failed for org ${orgId}`, { cause: error });
  }

  const auroraTenantId = data?.id;
  if (!auroraTenantId) {
    throw new Error(`Aurora API did not return a tenant id for org ${orgId}`);
  }

  console.log(`Aurora tenant ${auroraTenantId} created for org ${orgId}`);
  return { auroraTenantId };
}
