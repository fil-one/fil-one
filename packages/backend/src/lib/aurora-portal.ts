import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createClient, postTenantsByTenantIdBucket } from '@filone/aurora-portal-client';

const ssm = new SSMClient({});

export interface CreateAuroraBucketOptions {
  tenantId: string;
  bucketName: string;
}

export async function createAuroraBucket({
  tenantId,
  bucketName,
}: CreateAuroraBucketOptions): Promise<void> {
  const baseUrl = process.env.AURORA_PORTAL_URL!;
  const stage = process.env.FILONE_STAGE!;
  const apiKey = await getAuroraPortalApiKey(stage, tenantId);

  const client = createClient({
    baseUrl,
    headers: { 'X-Api-Key': apiKey },
  });

  const { error, response } = await postTenantsByTenantIdBucket({
    client,
    path: { tenantId },
    body: { name: bucketName },
    throwOnError: false,
  });

  if (error) {
    if (response?.status === 409) {
      console.log(
        `Aurora bucket "${bucketName}" already exists for tenant ${tenantId}, treating as success`,
      );
      return;
    }
    throw new Error(`Failed to create Aurora bucket "${bucketName}" for tenant ${tenantId}`, {
      cause: error,
    });
  }

  console.log(`Aurora bucket "${bucketName}" created for tenant ${tenantId}`);
}

export async function getAuroraPortalApiKey(stage: string, tenantId: string): Promise<string> {
  let apiKey: string | undefined;
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({
        Name: `/filone/${stage}/aurora-portal/tenant-api-key/${tenantId}`,
        WithDecryption: true,
      }),
    );
    apiKey = Parameter?.Value;
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') {
      throw new Error(`Aurora API key not found in SSM for tenant ${tenantId}`);
    }
    throw err;
  }

  if (!apiKey) {
    throw new Error(`Aurora API key not found in SSM for tenant ${tenantId}`);
  }

  return apiKey;
}
