import {
  createClient,
  postPartnersByPartnerIdTenants,
} from "../packages/aurora-backoffice-client/src/index.ts";

const partnerId = requireEnv("AURORA_PARTNER_ID");
const token = requireEnv("AURORA_TOKEN");
const baseUrl = requireEnv("AURORA_BASE_URL");

const client = createClient({
  baseUrl,
  headers: {
    'X-Api-Key': token,
    // Authorization: `Bearer ${token}`,
  },
});

client.interceptors.request.use((request) => {
  console.error(`${request.method} ${request.url}`);
  return request;
});

/*
const { data, error } = await getPartnersByPartnerIdTenants({
  client,
  path: { partnerId },
  throwOnError: false,
});

if (error) {
  console.error("Failed to list tenants:", error);
  process.exit(1);
}

console.log(JSON.stringify(data, null, 2));

const { data: regions, error: regionsError } =
  await getPartnersByPartnerIdRegions({
    client,
    path: { partnerId },
    throwOnError: false,
  });

if (regionsError) {
  console.error("Failed to list regions:", regionsError);
  process.exit(1);
}

console.log(JSON.stringify(regions, null, 2));
*/

const { data: tenant, error: createError } =
  await postPartnersByPartnerIdTenants({
    client,
    path: { partnerId },
    body: {
      name: "demo-tenant-2",
      displayName: "Demo Tenant 2",
      regionId: "ff",
    },
    throwOnError: false,
  });

if (createError) {
  console.error("Failed to create tenant:", createError);
  process.exit(1);
}

console.log(JSON.stringify(tenant, null, 2));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}
